"""The workspace eval's MCP door: Piloti's four meta-tools, served from a fixture office (ADR-0122).

The answer suite runs the real agent with no BFF, so its workspace tools
(``tools/workspace``) reach nothing and an office-operations turn cannot be
measured. ``fixture_bff.py`` mounts this on ``POST /api/mcp`` for
``suite.py --set workspace``:

- ``search-operations`` ranks the catalog production shows in-product Piloti
  (``frontends/ui/tests/fixtures/workspace/catalog.json``, written from the
  real catalog by ``workspace-eval.fixture.spec.ts``) with a mirror of the
  server's ranking, ``lib/text/operation-search.ts``, which ``discovery.ts``
  ranks with. It is held to the lists the spec wrote from the TypeScript
  (``tests/test_workspace_eval.py``), so the mirror cannot drift unseen.
- ``describe-operation`` answers the production text, verbatim.
- ``call-operation`` answers a read from ``office.json`` and turns a write into
  a proposal, as the server does for Piloti: nothing is changed, the model
  reads „Proposed — the person decides. Nothing was changed.", and the
  structured result carries the proposal id the card shows. The input is
  checked against the operation's schema for what it requires.
- ``report-missing-operation`` is recorded.

Every call is logged by the fixture BFF beside the run, with its arguments and
what it answered, so a check reads what the turn did on the door.
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path
from typing import Any

from fixture_bff import ROOT
from fixture_bff import _fold

FIXTURES = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "workspace"
VOCABULARY = ROOT / "frontends" / "ui" / "src" / "lib" / "text" / "operation-search-vocabulary.json"

#: As ``DEFAULT_SEARCH_LIMIT`` and ``MAX_SEARCH_LIMIT`` in ``discovery.ts``.
DEFAULT_SEARCH_LIMIT = 10
MAX_SEARCH_LIMIT = 50
#: As ``MAX_SEARCH_QUERY_LENGTH`` in ``discovery.ts``.
MAX_SEARCH_QUERY_LENGTH = 200
#: As ``PREFIX_MATCH_MIN_LENGTH``, ``COMPOUND_MIN_LENGTH`` and ``MIN_WORD_LENGTH`` in ``lib/text/operation-search.ts``.
PREFIX_MATCH_MIN_LENGTH = 5
COMPOUND_MIN_LENGTH = 10
MIN_WORD_LENGTH = 2
#: The text the server answers a proposed write with (``runOperation``).
PROPOSED_TEXT = "Proposed — the person decides. Nothing was changed."

_NOT_ALNUM = re.compile(r"[^a-z0-9]+")


# --- ranking ------------------------------------------------------------------


class Vocabulary:
    """``lib/text/operation-search.ts``'s word groups, from the same vocabulary file."""

    def __init__(self, path: Path = VOCABULARY) -> None:
        vocabulary = json.loads(path.read_text(encoding="utf-8"))
        self.terms: list[tuple[str, list[str]]] = list(vocabulary["terms"].items())
        self.inflections: frozenset[str] = frozenset(vocabulary["inflections"])

    def _is_form_of(self, word: str, term: str) -> bool:
        """``isFormOf``: the term itself, or the term inflected when it is long enough to be."""
        if len(term) < PREFIX_MATCH_MIN_LENGTH:
            return word == term
        return word.startswith(term) and word[len(term) :] in self.inflections

    def _meanings(self, word: str) -> list[str]:
        found: list[str] = []
        for term, meanings in self.terms:
            if self._is_form_of(word, term):
                found.extend(meaning for meaning in meanings if meaning not in found)
        return [meaning for meaning in found if meaning != word]

    def _compound(self, word: str) -> list[str]:
        if len(word) < COMPOUND_MIN_LENGTH:
            return []
        found = [
            (word.find(term), term) for term, _ in self.terms if len(term) >= PREFIX_MATCH_MIN_LENGTH and term in word
        ]
        found.sort(key=lambda entry: (entry[0], -len(entry[1])))
        parts: list[str] = []
        end = 0
        for at, term in found:
            if at < end:
                continue
            parts.append(term)
            end = at + len(term)
        return parts if len(parts) >= 2 else []

    def groups(self, query: str) -> list[list[str]]:
        groups: list[list[str]] = []
        for word in (word for word in _NOT_ALNUM.split(_fold(query)) if len(word) >= MIN_WORD_LENGTH):
            parts = self._compound(word)
            for part in parts or [word]:
                groups.append([part, *self._meanings(part)])
        return groups


def _scorer(query: str, groups: list[list[str]]) -> Any:
    """``operationScorer``: a blank query lists every operation, text with no usable word in it matches none."""
    lists_all = query.strip() == ""

    def score(op: dict[str, Any]) -> int:
        if not groups:
            return 1 if lists_all else 0
        name = _fold(op["name"])
        segments = name.split("-")
        summary = _fold(op["summary"])
        description = _fold(op["description"])

        def of(word: str) -> int:
            return (
                (3 if word in name else 0)
                + (1 if word in segments else 0)
                + (2 if word in summary else 0)
                + (1 if word in description else 0)
            )

        total = 0
        matched = 0
        for group in groups:
            best = max(of(word) for word in group)
            matched += 1 if best > 0 else 0
            total += best
        return total + (5 if matched == len(groups) else 0)

    return score


# --- the door -----------------------------------------------------------------


def _text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)


def _success(value: Any) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": _text(value)}],
        "structuredContent": value if isinstance(value, dict) else {"result": value},
    }


def _failure(message: str) -> dict[str, Any]:
    return {"isError": True, "content": [{"type": "text", "text": message}]}


def _missing(schema: dict[str, Any], value: Any, where: str) -> list[str]:
    """The required fields ``value`` lacks against ``schema``, as dotted paths; nested objects followed."""
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return []
    present = value if isinstance(value, dict) else {}
    gaps = [f"{where}{key}" for key in schema.get("required") or [] if present.get(key) in (None, "")]
    for key, child in (schema.get("properties") or {}).items():
        if key in present:
            gaps.extend(_missing(child, present[key], f"{where}{key}."))
    return gaps


class FixtureWorkspace:
    """The fixture office behind the four meta-tools, ranking searches as the server does."""

    def __init__(self, directory: Path = FIXTURES) -> None:
        catalog = json.loads((directory / "catalog.json").read_text(encoding="utf-8"))
        self.operations: list[dict[str, Any]] = catalog["operations"]
        self.by_name = {op["name"]: op for op in self.operations}
        self.office = json.loads((directory / "office.json").read_text(encoding="utf-8"))
        rendered = directory / "rendered.json"
        #: What the production renderers made of the office (``workspace-block.fixture.spec.ts``).
        self.rendered: dict[str, Any] = json.loads(rendered.read_text(encoding="utf-8")) if rendered.exists() else {}
        self.vocabulary = Vocabulary()
        #: The proposals each conversation filed, oldest first: what its next turn's WORKSPACE block lists.
        self._filed: dict[str, list[tuple[str, str]]] = {}
        self._lock = threading.Lock()

    def rank(self, query: str, domain: str | None = None) -> list[dict[str, Any]]:
        query = query[:MAX_SEARCH_QUERY_LENGTH]
        score = _scorer(query, self.vocabulary.groups(query))
        hits = [
            {
                "name": op["name"],
                "summary": op["summary"],
                "domain": op["domain"],
                "readOnly": op["readOnly"],
                "destructive": op["destructive"],
                "score": score(op),
            }
            for op in self.operations
            if not domain or op["domain"] == domain
        ]
        return sorted((hit for hit in hits if hit["score"] > 0), key=lambda hit: hit["score"], reverse=True)

    def search(self, arguments: dict[str, Any]) -> dict[str, Any]:
        query = str(arguments.get("query") or "")
        domain = arguments.get("domain")
        domains = sorted({op["domain"] for op in self.operations})
        if domain is not None and domain not in domains:
            # The server's input schema takes a domain from its enum and refuses anything else.
            expected = " | ".join(f"'{name}'" for name in domains)
            return _failure(f"search-operations: Invalid enum value. Expected {expected}, received '{domain}'")
        limit = max(1, min(int(arguments.get("limit") or DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT))
        hits = self.rank(query, domain)
        shown = [{key: value for key, value in hit.items() if key != "score"} for hit in hits[:limit]]
        return _success(
            {
                "total": len(hits),
                "operations": shown,
                "next": (
                    "Nothing matched. Try other words, drop the domain filter, or call report-missing-operation."
                    if not shown
                    else "Call describe-operation for the input schema, then call-operation."
                ),
            }
        )

    def _unknown(self, name: str) -> dict[str, Any]:
        near = [hit["name"] for hit in self.rank(name)[:5]]
        hint = f" Closest: {', '.join(near)}." if near else ""
        return _failure(f'Unknown operation "{name}".{hint} Use search-operations to find the right name.')

    def describe(self, arguments: dict[str, Any]) -> dict[str, Any]:
        name = str(arguments.get("name") or "")
        op = self.by_name.get(name)
        if op is None:
            return self._unknown(name)
        return {"content": [{"type": "text", "text": op["describe"]}], "structuredContent": json.loads(op["describe"])}

    def _read(self, op: dict[str, Any], call_input: dict[str, Any]) -> dict[str, Any]:
        data = (self.office.get("reads") or {}).get(op["name"])
        if data is None:
            return _failure(f"{op['name']} failed on the server. Try again; if it persists, report it.")
        params = call_input.get("params") or {}
        query = call_input.get("query") or {}
        key = params.get("id") or query.get("projectId")
        if isinstance(data, dict) and key is not None and key in data:
            return _success(data[key])
        if isinstance(data, dict) and any(_is_project_id(k, self.office) for k in data):
            # Keyed by project, and this project has nothing: an empty answer, as the route gives.
            return _success({})
        return _success(data)

    def _propose(self, op: dict[str, Any], call_input: dict[str, Any], conversation: str | None) -> dict[str, Any]:
        schema = json.loads(op["describe"]).get("inputSchema") or {}
        gaps = _missing(schema, call_input, "")
        if gaps:
            return _failure(
                f"Invalid input: {', '.join(gaps)} required. Use describe-operation for {op['name']} to see "
                "its input schema."
            )
        facts = [
            f"{key}: {value}"
            for part in ("body", "query", "params")
            for key, value in (call_input.get(part) or {}).items()
            if isinstance(value, str | int | float | bool) and str(value).strip()
        ][:4]
        summary = op["summary"].rstrip(".") + (f" ({', '.join(facts)})" if facts else "")
        # The same call in the same conversation files one proposal, as the server does.
        seed = json.dumps([conversation, op["name"], call_input], sort_keys=True, ensure_ascii=False)
        proposal_id = str(uuid.uuid5(uuid.NAMESPACE_URL, seed))
        with self._lock:
            filed = self._filed.setdefault(conversation or "", [])
            if all(existing != proposal_id for existing, _ in filed):
                filed.append((proposal_id, summary))
        return {
            "content": [{"type": "text", "text": PROPOSED_TEXT}],
            "structuredContent": {
                "decision": "propose",
                "proposalId": proposal_id,
                "summary": summary,
                "operation": op["name"],
            },
        }

    def call(self, arguments: dict[str, Any], conversation: str | None) -> dict[str, Any]:
        name = str(arguments.get("name") or "")
        op = self.by_name.get(name)
        if op is None:
            return self._unknown(name)
        call_input = arguments.get("input") if isinstance(arguments.get("input"), dict) else {}
        if op["readOnly"]:
            return self._read(op, call_input)
        return self._propose(op, call_input, conversation)

    def handle(self, body: dict[str, Any], conversation: str | None) -> dict[str, Any]:
        """One JSON-RPC ``tools/call``, answered as the server answers it."""
        params = body.get("params") if isinstance(body.get("params"), dict) else {}
        tool = params.get("name")
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        if tool == "search-operations":
            result = self.search(arguments)
        elif tool == "describe-operation":
            result = self.describe(arguments)
        elif tool == "call-operation":
            result = self.call(arguments, conversation)
        elif tool == "report-missing-operation":
            result = _success({"status": "recorded"})
        else:
            return {
                "jsonrpc": "2.0",
                "id": body.get("id"),
                "error": {"code": -32602, "message": f"Unknown tool {tool}"},
            }
        return {"jsonrpc": "2.0", "id": body.get("id"), "result": result}

    def turn_context(self, conversation: str | None, with_workspace: bool = True) -> dict[str, Any]:
        """The turn context of a chat in the office's current project: the WORKSPACE block, nothing else."""
        block = self.rendered.get("workspace") if with_workspace else None
        if block:
            block = self._with_proposals(block, conversation)
        return {
            "data": {
                "projectContext": None,
                "projectMemory": None,
                "orgInstructions": None,
                "drewOnOtherProjects": False,
                "referenceProjects": None,
                **({"workspace": block.replace("{conversation}", conversation or "none")} if block else {}),
            }
        }

    def _with_proposals(self, block: str, conversation: str | None) -> str:
        """The block with the proposals this conversation filed, newest first, in the renderer's own lines."""
        with self._lock:
            filed = list(self._filed.get(conversation or "", []))
        if not filed:
            return block
        template = self.rendered["proposalLine"]
        lines = [template.replace("{id}", pid).replace("{summary}", summary) for pid, summary in reversed(filed[-8:])]
        return block.replace(
            "proposals made in this conversation: none", "\n".join([self.rendered["proposalsHeader"], *lines])
        )


def _is_project_id(key: str, office: dict[str, Any]) -> bool:
    return any(project["id"] == key for project in office.get("projects") or [])


def workspace_calls(log_path: Path, conversation_id: str) -> list[dict[str, Any]]:
    """The calls this conversation made on the door, in order: ``{tool, arguments, result}`` each."""
    if not log_path.exists():
        return []
    calls = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("path") != "/api/mcp" or entry.get("conversation") != conversation_id:
            continue
        params = (entry.get("body") or {}).get("params") or {}
        calls.append(
            {
                "tool": params.get("name"),
                "arguments": params.get("arguments") or {},
                "result": entry.get("result") or {},
            }
        )
    return calls
