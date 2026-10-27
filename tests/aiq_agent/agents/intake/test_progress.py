"""The run's live progress (``op: progress``): the setup page counts the documents while Piloti reads.

``finish`` alone left „23 Dokumente gelesen" at the last reading's number until
the end. The middleware now reports after every tool call, and only when the
read log has a file it has not reported yet.
"""

from __future__ import annotations

from types import SimpleNamespace

from aiq_agent_testing.intake import JOB
from langchain_core.messages import ToolMessage

from aiq_agent.agents.intake.reading import IntakeToolMiddleware
from aiq_agent.agents.intake.tools import IntakeSession
from aiq_agent.agents.intake.tools import report_progress


def _request(name: str) -> SimpleNamespace:
    return SimpleNamespace(tool_call={"name": name, "id": f"call-{name}", "args": {}})


class TestReportProgress:
    async def test_reports_every_file_opened_once_the_log_grows(self, signed_run, route, read_log):
        fake = route()
        session = IntakeSession(job_id=JOB)

        await report_progress(session)
        assert fake.bodies("progress") == [], "nothing opened, nothing sent"

        read_log.mark_opened("Einreichplan.pdf")
        await report_progress(session)
        await report_progress(session)
        read_log.mark_opened("Baubeschreibung.pdf")
        await report_progress(session)

        assert [body["filesOpened"] for body in fake.bodies("progress")] == [
            ["Einreichplan.pdf"],
            ["Einreichplan.pdf", "Baubeschreibung.pdf"],
        ]
        assert session.progress_reports == 2

    async def test_a_failed_report_is_tried_again_and_a_stale_one_stops_the_reports(self, signed_run, route, read_log):
        fake = route(progress=500)
        session = IntakeSession(job_id=JOB)
        read_log.mark_opened("Einreichplan.pdf")

        await report_progress(session)
        fake.answers["progress"] = {"filesOpened": 1}
        await report_progress(session)
        assert len(fake.bodies("progress")) == 2 and session.progress_reports == 1

        fake.answers["progress"] = 409
        read_log.mark_opened("Schnitt.pdf")
        await report_progress(session)
        read_log.mark_opened("Ansicht.pdf")
        await report_progress(session)
        assert session.stale and len(fake.bodies("progress")) == 3

    async def test_a_finished_run_reports_nothing(self, signed_run, route, read_log):
        fake = route()
        session = IntakeSession(job_id=JOB, finished=True)
        read_log.mark_opened("Einreichplan.pdf")
        await report_progress(session)
        assert fake.bodies("progress") == []


class TestTheMiddlewareReports:
    async def test_after_every_tool_call_and_never_at_the_cost_of_its_result(self, read_log):
        calls: list[str] = []

        async def after_call() -> None:
            calls.append("after")
            raise RuntimeError("the BFF is down")

        middleware = IntakeToolMiddleware(max_steps=5, finish_tool="finish_intake", after_call=after_call)

        async def handler(request):
            return ToolMessage(content="ok", tool_call_id=request.tool_call["id"], name=request.tool_call["name"])

        result = await middleware.awrap_tool_call(_request("read_document"), handler)

        assert result.content == "ok"
        assert calls == ["after"]
