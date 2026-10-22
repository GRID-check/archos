"""``ifc_query`` and ``ifc_measure``: one ``model`` row per call (ADR-0131), settled from the typed answer."""

from __future__ import annotations

import pytest

from aiq_agent.tools.bim import measure_register as measure
from aiq_agent.tools.bim import register as query


def _rows(emitted):
    actions = [step for step in emitted.steps if step.kind == "action"]
    assert [step.status for step in actions][0] == "running"
    assert len(actions) == 2
    assert actions[0].id == actions[1].id
    return actions


@pytest.fixture
def context(monkeypatch):
    monkeypatch.setattr(query, "get_organization_id_from_context", lambda: "org")
    monkeypatch.setattr(query, "get_project_id_from_context", lambda: "proj")
    monkeypatch.setattr(measure, "get_organization_id_from_context", lambda: "org")
    monkeypatch.setattr(measure, "get_project_id_from_context", lambda: "proj")


class TestIfcQueryRow:
    async def test_a_list_answer_counts_its_rows(self, context, emitted, monkeypatch) -> None:
        elements = [{"globalId": f"g{i}", "ifcType": "IfcWall"} for i in range(3)]
        monkeypatch.setattr(
            query,
            "run_bim_query",
            lambda **kw: {"resolved": True, "model": {"filename": "m.ifc"}, "elements": elements},
        )

        await query.run_ifc_query(query.IfcQueryInput(operation="elements", ifc_type="IfcWall"), 25)

        started, finished = _rows(emitted)
        assert (started.verb, started.query) == ("model", "elements IfcWall")
        assert (finished.status, finished.counts.hits) == ("ok", 3)

    async def test_a_scalar_answer_counts_nothing_and_is_ok(self, context, emitted, monkeypatch) -> None:
        monkeypatch.setattr(query, "run_bim_query", lambda **kw: {"resolved": True, "model": {}, "overview": {}})

        await query.run_ifc_query(query.IfcQueryInput(operation="overview"), 25)

        finished = _rows(emitted)[1]
        assert finished.status == "ok"
        assert finished.counts is None

    async def test_no_model_is_an_error_row(self, context, emitted, monkeypatch) -> None:
        monkeypatch.setattr(query, "run_bim_query", lambda **kw: {"resolved": False, "reason": "no_model"})

        await query.run_ifc_query(query.IfcQueryInput(operation="overview"), 25)

        assert _rows(emitted)[1].status == "error"

    async def test_a_refused_argument_is_an_error_row(self, context, emitted) -> None:
        await query.run_ifc_query(query.IfcQueryInput(operation="count_walls"), 25)

        assert _rows(emitted)[1].status == "error"

    async def test_an_unavailable_service_is_an_error_row(self, context, emitted, monkeypatch) -> None:
        def _down(**kw):
            raise query.QUERY_FAILURES.exceptions[0]("down")

        monkeypatch.setattr(query, "run_bim_query", _down)

        await query.run_ifc_query(query.IfcQueryInput(operation="overview"), 25)

        assert _rows(emitted)[1].status == "error"

    async def test_no_project_is_an_error_row(self, emitted, monkeypatch) -> None:
        monkeypatch.setattr(query, "get_organization_id_from_context", lambda: "org")
        monkeypatch.setattr(query, "get_project_id_from_context", lambda: None)

        await query.run_ifc_query(query.IfcQueryInput(operation="overview"), 25)

        assert _rows(emitted)[1].status == "error"


class TestIfcMeasureRow:
    async def test_find_elements_counts_its_hits(self, context, emitted, monkeypatch) -> None:
        payload = {"elements": [{"globalId": "a"}, {"globalId": "b"}], "total": 2}
        monkeypatch.setattr(measure, "_run", lambda *args: ({"resolved": True, "model": {}}, payload, "handle"))

        await measure.run_ifc_measure(measure.IfcMeasureInput(operation="find_elements"), 50)

        started, finished = _rows(emitted)
        assert (started.verb, started.query) == ("model", "find_elements")
        assert (finished.status, finished.counts.hits) == ("ok", 2)

    async def test_an_unresolved_model_is_an_error_row(self, context, emitted, monkeypatch) -> None:
        monkeypatch.setattr(measure, "_run", lambda *args: ({"resolved": False, "reason": "no_model"}, None, ""))

        await measure.run_ifc_measure(measure.IfcMeasureInput(operation="find_elements"), 50)

        assert _rows(emitted)[1].status == "error"

    async def test_a_missing_global_id_is_an_error_row(self, context, emitted) -> None:
        await measure.run_ifc_measure(measure.IfcMeasureInput(operation="measure"), 50)

        assert _rows(emitted)[1].status == "error"
