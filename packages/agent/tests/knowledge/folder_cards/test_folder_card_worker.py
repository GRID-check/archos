"""The builder end to end on a real agent DB: the hooks mark, the worker climbs, skips, stops and stays in budget."""

from __future__ import annotations

import pytest
from agent_testing.folder_cards import FakeModel
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from aiq_agent.knowledge import factory
from aiq_agent.knowledge.folder_cards import queue
from aiq_agent.knowledge.folder_cards import worker
from aiq_agent.observability import direct_trace

ORG = "org_1"


@pytest.fixture
def quiet(monkeypatch):
    """No debounce: a mark is due at once."""
    monkeypatch.setattr(queue, "QUIET_SECONDS", 0)


def _file(name, folder, summary="Ein Dokument."):
    factory.register_summary("proj", name, summary)
    factory.set_document_folder_path("proj", name, folder)


def _paths():
    return [path for path, _dirty, _marked in queue.queued("proj")]


@pytest.fixture
def project(agent_db, bff, quiet):
    for name in ("BS-Gutachten.pdf", "Statik.pdf", "Schall.pdf"):
        _file(name, "Gutachten")
    for name in ("Bescheid 1.pdf", "Bescheid 2.pdf", "Bescheid 3.pdf"):
        _file(name, "Gutachten/Behörde")
    _file("Grundriss.pdf", "Pläne")
    bff.folders |= {("proj", "Gutachten"), ("proj", "Gutachten/Behörde"), ("proj", "Pläne")}
    queue.remember_collection("proj", ORG)
    return bff


def _abstracts(prompt: str) -> dict:
    folder = prompt.split("\n")[1]
    return {"abstract": f"Ordner {folder}.", "key_facts": []}


class TestHooks:
    def test_filing_a_document_marks_its_folder_and_every_folder_above(self, agent_db):
        _file("Bescheid.pdf", "Gutachten/Behörde/2026")

        assert _paths() == ["Gutachten", "Gutachten/Behörde", "Gutachten/Behörde/2026"]

    def test_a_move_marks_the_folder_it_left(self, agent_db):
        _file("Bescheid.pdf", "Alt")
        queue.finish(queue.Claim("proj", "Alt", None, 1, 1e12, 1))

        factory.set_document_folder_path("proj", "Bescheid.pdf", "Neu")

        assert _paths() == ["Alt", "Neu"]

    def test_a_delete_marks_the_folder_it_left(self, agent_db):
        _file("Bescheid.pdf", "Alt")
        queue.finish(queue.Claim("proj", "Alt", None, 1, 1e12, 1))

        factory.unregister_summary("proj", "Bescheid.pdf")

        assert _paths() == ["Alt"]

    def test_a_folder_rewrite_marks_the_old_and_the_new_path(self, agent_db):
        _file("Bescheid.pdf", "Alt/Sub")
        for path in ("Alt", "Alt/Sub"):
            queue.finish(queue.Claim("proj", path, None, 1, 1e12, 1))

        factory.rewrite_document_folder_paths("proj", "Alt", "Neu")

        assert _paths() == ["Alt", "Neu", "Neu/Sub"]

    def test_an_ingest_names_the_organization(self, agent_db, quiet):
        from aiq_agent.common.cost_tracking import BudgetSnapshot
        from aiq_agent.common.cost_tracking import track_llm_costs

        with track_llm_costs(identity={"organization_id": ORG}, budget=BudgetSnapshot(), inline_flush=False):
            _file("Bescheid.pdf", "Behörde")

        (claim,) = queue.claim(5)
        assert claim.organization_id == ORG

    def test_flag_off_marks_nothing(self, agent_db, folder_cards_flag):
        folder_cards_flag.off(ORG)

        _file("Bescheid.pdf", "Behörde")

        assert _paths() == []

    def test_no_known_organization_marks_nothing(self, agent_db, folder_cards_flag, monkeypatch):
        monkeypatch.setattr("aiq_agent.knowledge.folder_cards.organization_for", lambda collection: None)

        _file("Bescheid.pdf", "Behörde")

        assert _paths() == []

    def test_the_env_var_is_no_longer_read(self, agent_db, folder_cards_flag, monkeypatch):
        monkeypatch.setenv("FOLDER_CARDS", "on")
        folder_cards_flag.off(ORG)

        _file("Bescheid.pdf", "Behörde")

        assert _paths() == []


class TestRunOnce:
    async def test_children_first_then_the_parent_reads_the_childs_abstract(self, project):
        model = FakeModel(_abstracts)

        first = await worker.run_once(llm=model)
        second = await worker.run_once(llm=model)

        assert first.outcomes == {"fresh": 1, "skipped": 1}  # Behörde built, Pläne too small
        assert second.outcomes == {"fresh": 1}
        assert [prompt.split("\n")[1] for prompt in model.calls] == ["Gutachten/Behörde", "Gutachten"]
        assert "- Behörde/: Ordner Gutachten/Behörde." in model.calls[1]
        assert set(project.cards) == {("proj", "Gutachten/Behörde"), ("proj", "Gutachten")}
        assert _paths() == []

    async def test_flag_off_builds_nothing_and_drops_the_queue(self, project, folder_cards_flag):
        folder_cards_flag.off(ORG)
        model = FakeModel(_abstracts)

        report = await worker.run_once(llm=model)

        assert report.outcomes == {"skipped": 2}  # claimed the deepest two folders, dropped both
        assert model.calls == []
        assert project.cards == {}

    async def test_flag_lookup_failure_keeps_the_claim_for_a_retry(self, project, monkeypatch):
        from aiq_agent.knowledge.folder_cards import gate

        def down(organization_id):
            raise OSError("BFF down")

        gate.forget()
        monkeypatch.setattr(gate, "_fetch", down)
        model = FakeModel(_abstracts)

        report = await worker.run_once(llm=model)

        assert report.outcomes.get("failed", 0) >= 1
        assert model.calls == []
        assert _paths() != []

    async def test_nothing_changed_is_no_model_call(self, project):
        model = FakeModel(_abstracts)
        await worker.run_once(llm=model)
        await worker.run_once(llm=model)
        queue.mark("proj", ["Gutachten/Behörde"], ORG)

        report = await worker.run_once(llm=model)

        assert report.outcomes == {"unchanged": 1}
        assert len(model.calls) == 2

    async def test_an_identical_abstract_stops_the_climb(self, project):
        model = FakeModel(_abstracts)
        await worker.run_once(llm=model)
        await worker.run_once(llm=model)

        _file("Bescheid 3.pdf", "Gutachten/Behörde")  # re-read: a new summary, same folder
        factory.register_summary("proj", "Bescheid 3.pdf", "Bescheid, neu gelesen.")
        child = await worker.run_once(llm=model)
        parent = await worker.run_once(llm=model)

        assert child.outcomes == {"fresh": 1}
        assert parent.outcomes == {"unchanged": 1}
        assert len(model.calls) == 3

    async def test_a_fact_citing_no_child_never_reaches_the_bff(self, project):
        def reply(prompt):
            return {
                "abstract": "Bescheide.",
                "key_facts": [
                    {"statement": "Bescheid erteilt.", "documents": ["Bescheid 1.pdf"], "pages": None},
                    {"statement": "Erfunden.", "documents": ["Gibt es nicht.pdf"], "pages": None},
                ],
            }

        await worker.run_once(llm=FakeModel(reply))

        (put,) = project.puts
        assert put["key_facts"] == [{"statement": "Bescheid erteilt.", "documents": ["Bescheid 1.pdf"]}]
        assert put["status"] == "fresh" and put["organization_id"] == ORG

    async def test_over_budget_the_card_is_marked_stale_and_nothing_is_built(self, project, monkeypatch):
        model = FakeModel(_abstracts)
        await worker.run_once(llm=model)
        monkeypatch.setenv(worker.MONTHLY_TOKENS_ENV, "1000")
        factory.register_summary("proj", "Bescheid 1.pdf", "Bescheid, geändert.")

        report = await worker.run_once(llm=model)

        assert report.outcomes == {"stale": 1}
        assert len(model.calls) == 1
        assert project.cards[("proj", "Gutachten/Behörde")]["status"] == "stale"
        assert project.points[-1] == ("status", "proj", "Gutachten/Behörde", "stale")

    async def test_a_folder_that_shrank_below_the_threshold_loses_its_card(self, project):
        await worker.run_once(llm=FakeModel(_abstracts))
        factory.unregister_summary("proj", "Bescheid 1.pdf")
        factory.unregister_summary("proj", "Bescheid 2.pdf")

        report = await worker.run_once(llm=FakeModel(_abstracts))

        assert report.outcomes == {"skipped": 1}
        assert ("proj", "Gutachten/Behörde") in project.deletes
        assert ("proj", "Gutachten/Behörde") not in project.cards
        assert project.points[-1] == ("delete", "proj", "Gutachten/Behörde", None)

    async def test_a_failed_build_is_retried_and_the_pass_goes_on(self, project):
        def reply(prompt):
            raise RuntimeError("provider down")

        report = await worker.run_once(llm=FakeModel(reply))

        assert report.outcomes == {"failed": 1, "skipped": 1}
        assert "Gutachten/Behörde" in _paths()

    async def test_a_folder_this_collection_does_not_own_is_dropped_without_a_model_call(self, project):
        # "Pläne" has one file; add more so only ownership, not size, decides.
        for name in ("Schnitt.pdf", "Ansicht.pdf", "Detail.pdf"):
            _file(name, "Pläne")
        project.folders.discard(("proj", "Pläne"))
        queue.mark("proj", ["Pläne"], ORG)
        model = FakeModel(_abstracts)

        report = await worker.run_once(llm=model)

        assert report.outcomes == {"fresh": 1, "skipped": 1}  # Behörde built, Pläne not ours
        assert all("Pläne" not in prompt.split("\n")[1] for prompt in model.calls)
        assert queue.tokens_used(ORG) == 1100  # one build, none for Pläne
        assert "Pläne" not in _paths()

    async def test_a_card_the_bff_refuses_is_skipped_not_fresh(self, project, monkeypatch):
        monkeypatch.setattr(worker.client, "put_card", lambda body: False)

        report = await worker.run_once(llm=FakeModel(_abstracts))

        assert report.outcomes == {"skipped": 2}
        assert queue.get_manifest("proj", "Gutachten/Behörde") is None

    async def test_an_unparsable_reply_still_costs_the_budget(self, project):
        class Garbage(FakeModel):
            async def ainvoke(self, messages):
                message = await super().ainvoke(messages)
                message.content = "kein JSON"
                return message

        report = await worker.run_once(llm=Garbage(_abstracts))

        assert report.outcomes == {"failed": 1, "skipped": 1}
        assert queue.tokens_used(ORG) == 1100

    async def test_no_summary_model_builds_nothing(self, project, monkeypatch):
        monkeypatch.setattr(worker, "summary_llm", lambda: None)

        assert (await worker.run_once()).outcomes == {}


class TestFreshnessScore:
    async def test_a_pass_that_built_writes_the_share_on_its_generations_trace(self, project, monkeypatch):
        from aiq_agent.observability import langfuse_scores

        direct_trace.reset_tracer_provider()
        direct_trace.install_tracer_provider(None, env={}, exporter=InMemorySpanExporter())
        written = []
        monkeypatch.setattr(langfuse_scores, "emit_scores", lambda scores, **kw: written.append((list(scores), kw)))
        try:
            report = await worker.run_once(llm=FakeModel(_abstracts))
        finally:
            direct_trace.reset_tracer_provider()

        (((score,), kwargs),) = written
        assert (score.name, score.value) == ("folder-card-fresh", 1.0)
        assert kwargs["trace_id"] == report.trace_id and report.trace_id


class TestReconcile:
    async def test_a_card_whose_inputs_moved_on_is_marked_and_a_missing_card_too(self, project):
        await worker.run_once(llm=FakeModel(_abstracts))
        await worker.run_once(llm=FakeModel(_abstracts))
        project.cards[("proj", "Gutachten")]["input_hash"] = "outdated"
        project.cards.pop(("proj", "Gutachten/Behörde"))

        marked = worker.reconcile_collection("proj", ORG)

        assert marked == 2
        assert _paths() == ["Gutachten", "Gutachten/Behörde"]
        assert queue.collections_due_for_reconcile(3600) == []


class TestTheQdrantPoint:
    async def test_every_card_the_bff_accepted_gets_its_point_with_the_written_card(self, project):
        await worker.run_once(llm=FakeModel(_abstracts))

        written = {(collection, path): card for op, collection, path, card in project.points if op == "put"}
        assert set(written) == {("proj", put["folder_path"]) for put in project.puts}
        assert (
            written[("proj", "Gutachten/Behörde")]["abstract"]
            == project.cards[("proj", "Gutachten/Behörde")]["abstract"]
        )

    async def test_a_card_the_bff_refused_gets_no_point(self, project):
        project.folders.discard(("proj", "Gutachten/Behörde"))

        await worker.run_once(llm=FakeModel(_abstracts))

        assert ("proj", "Gutachten/Behörde") not in {(c, p) for _op, c, p, _d in project.points}

    def test_a_point_that_cannot_be_written_never_fails_the_card(self, monkeypatch, caplog):
        from aiq_agent.knowledge import factory as knowledge_factory

        def broken():
            raise RuntimeError("no embedder")

        monkeypatch.setattr(knowledge_factory, "get_active_retriever", broken)

        worker._publish_point("proj_1", {"folder_path": "Gutachten", "abstract": "Ein Ordner.", "key_facts": []})

        assert "no Qdrant point for Gutachten" in caplog.text
