"""The intake route, faked in-process for the eval: the BFF's own needs and record logic, no database.

``POST /api/internal/project-intake`` is answered by the transport double the
agent's suite uses too (``FakeIntakeRoute`` below, installed on
``client._opener.open``), so every body the agent sends is the one
``post_intake`` really built. Behind it, ``needs``, ``record`` and ``withdraw``
run the TypeScript the route runs (``computeNeeds``, ``staticRefusal``,
``planRecord`` and ``planWithdraw``, through ``gate.ts`` under bun), against a
profile this module keeps in memory: the vocabulary, unknown-key, dismissed and
unreadable-file refusals, corroboration and contradiction, the needs a record
opened, a withdrawal, and the derived Gebäudeklasse all behave as they do in
production. Not reproduced: masking the quote (the
fixture holds no personal data) and the job's database row (a stale ``jobId``
still answers 409, as the route does).
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

from .fixture import REPO_ROOT
from .fixture import Fixture

GATE = Path(__file__).with_name("gate.ts")
JOB_ID = "intake-eval-job"


class GateError(RuntimeError):
    """The bun gate could not answer."""


class Gate:
    """One long-lived ``bun run gate.ts``: a JSON request per line, a JSON answer per line."""

    def __init__(self) -> None:
        bun = shutil.which("bun")
        if bun is None:
            raise GateError("bun is not on the PATH; the intake route's logic runs under bun (gate.ts)")
        self._process = subprocess.Popen(
            [bun, "run", str(GATE)],
            cwd=REPO_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        self._lock = threading.Lock()

    def ask(self, request: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            assert self._process.stdin is not None and self._process.stdout is not None
            # Bytes on the pipes, UTF-8 by hand: the locale's encoding is not the gate's.
            self._process.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
            self._process.stdin.flush()
            line = self._process.stdout.readline().decode("utf-8")
        if not line:
            raise GateError("the gate process ended")
        return json.loads(line)

    def close(self) -> None:
        if self._process.stdin:
            self._process.stdin.close()
        self._process.wait(timeout=10)


class FakeIntakeBff:
    """The intake route for one fixture project: needs, record and finish, with the profile in memory."""

    def __init__(self, fixture: Fixture, gate: Gate) -> None:
        self.fixture = fixture
        self.gate = gate
        self.profile: dict[str, Any] = gate.ask({"op": "empty"})["profile"]
        #: Every value the route answered, in order: the value, its evidence and what it became; a
        #: withdrawal is an entry of its own (``outcome: withdrawn``), so the scoring sees the order.
        self.records: list[dict[str, Any]] = []
        self.finish_body: dict[str, Any] | None = None
        #: The label of every need the route listed, for the summary check (a threshold is not a value).
        self.need_labels: set[str] = set()
        self._lock = threading.Lock()

    def answers(self) -> dict[str, Any]:
        """The per-op answers ``FakeIntakeRoute`` takes."""
        return {"needs": self.needs, "record": self.record, "withdraw": self.withdraw, "finish": self.finish}

    def needs(self, body: dict[str, Any]) -> dict[str, Any] | int:
        if body.get("jobId") != JOB_ID:
            return 409
        with self._lock:
            needs = self.gate.ask({"op": "needs", "profile": self.profile, "mode": "active", "dismissed": []})
            self.need_labels.update(str(need.get("label") or "") for need in needs["needs"])
        return {
            "needs": needs["needs"],
            "unreadFiles": self.fixture.names,
            "description": self.fixture.description,
            "location": None,
            "mode": "active",
            "previousSummary": None,
        }

    def record(self, body: dict[str, Any]) -> dict[str, Any] | int:
        if body.get("jobId") != JOB_ID:
            return 409
        with self._lock:
            answer = self.gate.ask(
                {"op": "record", "profile": self.profile, "body": body, "readableFiles": self.fixture.names}
            )
            if answer.get("status") != 200:
                return int(answer.get("status") or 500)
            self.profile = answer["profile"]
            for value, result in zip(body["values"], answer["results"], strict=True):
                self.records.append({**result, "value": value["value"], **value["evidence"]})
        return {"results": answer["results"], "opened": answer["opened"]}

    def withdraw(self, body: dict[str, Any]) -> dict[str, Any] | int:
        if body.get("jobId") != JOB_ID:
            return 409
        with self._lock:
            answer = self.gate.ask({"op": "withdraw", "profile": self.profile, "body": body})
            if answer.get("status") != 200:
                return int(answer.get("status") or 500)
            self.profile = answer["profile"]
            self.records.extend(dict(result) for result in answer["results"])
        return {"results": answer["results"]}

    def finish(self, body: dict[str, Any]) -> dict[str, Any] | int:
        if body.get("jobId") != JOB_ID:
            return 409
        self.finish_body = body
        return {"status": "ready"}


class FakeIntakeRoute:
    """``_opener.open`` answering by op: a dict is a 200 body, an int an HTTP error, an exception raised.

    The agent's intake suite installs it too (``agent_testing.intake``), with its needs as the default.
    """

    def __init__(self, **answers: Any) -> None:
        self.answers = {"progress": {"filesOpened": 1}, "finish": {"status": "ready"}, **answers}
        self.requests: list[urllib.request.Request] = []

    def bodies(self, op: str | None = None) -> list[dict[str, Any]]:
        bodies = [json.loads(request.data) for request in self.requests]
        return [body for body in bodies if op is None or body["op"] == op]

    def __call__(self, request: urllib.request.Request, timeout: float) -> Any:
        self.requests.append(request)
        body = json.loads(request.data)
        answer = self.answers[body["op"]]
        if callable(answer):
            answer = answer(body)
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, int):
            error = json.dumps({"error": "stale-reading" if answer == 409 else "nope"}).encode()
            raise urllib.error.HTTPError(request.full_url, answer, "refused", {}, io.BytesIO(error))
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(answer).encode("utf-8")
        return response
