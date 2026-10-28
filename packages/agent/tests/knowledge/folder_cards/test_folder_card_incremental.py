"""Incremental card updates: the manifest, the diff, the plan, and what the model is (and is not) shown."""

from __future__ import annotations

import pytest
from agent_testing.folder_cards import FakeModel
from knowledge_layer.browse import file_rows
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from agent.knowledge import factory
from agent.knowledge.folder_cards import build
from agent.knowledge.folder_cards import incremental
from agent.knowledge.folder_cards import queue
from agent.knowledge.folder_cards import worker
from agent.knowledge.folder_cards.inputs import folder_inputs
from agent.observability import direct_trace

ORG = "org_1"
NAMES = [f"Akt {n}.pdf" for n in range(1, 7)]


def _inputs(summaries=None, names=NAMES, description=None):
    summaries = summaries or {}
    rows = [
        {"file_name": name, "folder_path": "Akten", "collection": "proj", "summary": summaries.get(name, "Ein Akt.")}
        for name in names
    ]
    cards = {"Akten": {"folder_description": description}} if description else {}
    return folder_inputs("proj", "Akten", file_rows(rows), cards)


CARD = {"abstract": "Akten des Projekts.", "abstract_hash": "h", "key_facts": []}


class TestManifest:
    def test_it_round_trips(self):
        manifest = incremental.manifest_of(_inputs(description="Alle Akten"), increments=3)

        assert incremental.Manifest.from_json(manifest.to_json()) == manifest

    def test_a_summary_change_is_a_changed_child_and_nothing_else(self):
        before = incremental.manifest_of(_inputs())
        after = incremental.manifest_of(_inputs({"Akt 2.pdf": "Neu gelesen."}, names=[*NAMES[1:], "Akt 9.pdf"]))

        change = incremental.diff(before, after)

        assert (change.added, change.removed, change.changed) == (("Akt 9.pdf",), ("Akt 1.pdf",), ("Akt 2.pdf",))
        assert change.counts() == {"diff_added": 1, "diff_removed": 1, "diff_changed": 1}


class TestPlan:
    def _plan(self, inputs, manifest, card=CARD):
        return incremental.plan(card, manifest, inputs)

    def test_no_prior_card_or_manifest_is_full(self):
        assert self._plan(_inputs(), None).mode == "full"
        assert self._plan(_inputs(), incremental.manifest_of(_inputs()), card=None).mode == "full"

    def test_a_new_prompt_version_or_description_is_full(self):
        old_prompt = incremental.Manifest(**{**incremental.manifest_of(_inputs()).__dict__, "prompt_version": "v0"})

        assert self._plan(_inputs(), old_prompt).reason == "prompt version"
        assert self._plan(_inputs(description="Neu"), incremental.manifest_of(_inputs())).reason == "description"

    def test_ten_increments_in_a_row_is_full(self):
        tenth = incremental.manifest_of(_inputs(), increments=incremental.MAX_INCREMENTS)

        assert self._plan(_inputs({"Akt 1.pdf": "x"}), tenth).reason == "increments"

    def test_a_diff_over_half_the_children_is_full(self):
        many = {name: "Neu." for name in NAMES[:4]}

        assert self._plan(_inputs(many), incremental.manifest_of(_inputs())).reason == "share"

    def test_a_small_change_is_incremental_and_counts(self):
        update = self._plan(_inputs({"Akt 1.pdf": "Neu."}), incremental.manifest_of(_inputs(), increments=2))

        assert (update.mode, update.increments) == ("incremental", 3)

    def test_only_removals_is_a_prune(self):
        update = self._plan(_inputs(names=NAMES[1:]), incremental.manifest_of(_inputs(), increments=2))

        assert (update.mode, update.increments, update.diff.removed) == ("prune", 2, ("Akt 1.pdf",))

    def test_facts_survive_only_while_every_document_they_cite_is_a_child(self):
        facts = [
            {"statement": "a", "documents": ["Akt 1.pdf"]},
            {"statement": "b", "documents": ["Akt 2.pdf", "Weg.pdf"]},
            {"statement": "c", "documents": ["Akt 3.pdf"], "pages": "2"},
        ]

        kept = incremental.surviving_facts(facts, ["Akt 1.pdf", "Akt 2.pdf", "Akt 3.pdf"])

        assert [fact["statement"] for fact in kept] == ["a", "c"]


def test_the_incremental_prompt_holds_the_old_card_and_the_diff_alone():
    inputs = _inputs({"Akt 2.pdf": "Neu gelesen."}, names=[*NAMES[1:], "Akt 9.pdf"])
    change = incremental.diff(incremental.manifest_of(_inputs()), incremental.manifest_of(inputs))
    facts = [{"statement": "Akt 3 liegt vor.", "documents": ["Akt 3.pdf"], "pages": "4"}]

    prompt = build.incremental_prompt(inputs, change, "Akten des Projekts.", facts)

    assert "Abstract: Akten des Projekts." in prompt
    assert "- Akt 3 liegt vor. [Akt 3.pdf, pages 4]" in prompt
    assert "- Akt 9.pdf\n  Ein Akt." in prompt and "- Akt 2.pdf\n  Neu gelesen." in prompt
    assert "### Removed documents\n- Akt 1.pdf" in prompt
    for untouched in ("Akt 4.pdf", "Akt 5.pdf", "Akt 6.pdf"):
        assert untouched not in prompt


# ---------------------------------------------------------------------------
# The worker
# ---------------------------------------------------------------------------


@pytest.fixture
def folder(agent_db, bff, monkeypatch):
    monkeypatch.setattr(queue, "QUIET_SECONDS", 0)
    for name in NAMES:
        factory.register_summary("proj", name, "Ein Akt.")
        factory.set_document_folder_path("proj", name, "Akten")
    bff.folders.add(("proj", "Akten"))
    queue.remember_collection("proj", ORG)
    return bff


def _card(prompt):
    return {
        "abstract": "Akten des Projekts.",
        "key_facts": [
            {"statement": "Akt 1 ist der erste.", "documents": ["Akt 1.pdf"], "pages": None},
            {"statement": "Akt 2 ist der zweite.", "documents": ["Akt 2.pdf"], "pages": None},
        ],
    }


def _increments():
    return incremental.Manifest.from_json(queue.get_manifest("proj", "Akten")).increments


class TestWorker:
    async def test_a_change_sends_the_old_card_and_the_diff_only(self, folder):
        model = FakeModel(_card)
        await worker.run_once(llm=model)
        factory.register_summary("proj", "Akt 4.pdf", "Akt, neu gelesen.")

        report = await worker.run_once(llm=model)

        assert report.outcomes == {"fresh": 1}
        prompt = model.calls[-1]
        assert "## Current card" in prompt and "Akt 4.pdf\n  Akt, neu gelesen." in prompt
        assert "Akt 5.pdf" not in prompt and "## Documents directly in this folder" not in prompt
        assert _increments() == 1

    async def test_a_removed_child_loses_its_facts_without_a_model_call(self, folder):
        model = FakeModel(_card)
        await worker.run_once(llm=model)
        factory.unregister_summary("proj", "Akt 1.pdf")

        report = await worker.run_once(llm=model)

        assert report.outcomes == {"fresh": 1}
        assert len(model.calls) == 1
        card = folder.cards[("proj", "Akten")]
        assert card["abstract"] == "Akten des Projekts."
        assert [fact["documents"] for fact in card["key_facts"]] == [["Akt 2.pdf"]]

    async def test_a_removal_the_abstract_names_is_rewritten_not_pruned(self, folder):
        first = FakeModel(lambda prompt: {"abstract": "Akten, darunter Akt 1.", "key_facts": []})
        await worker.run_once(llm=first)
        factory.unregister_summary("proj", "Akt 1.pdf")
        second = FakeModel(lambda prompt: {"abstract": "Akten des Projekts.", "key_facts": []})

        report = await worker.run_once(llm=second)

        assert report.outcomes == {"fresh": 1}
        assert len(second.calls) == 1 and "Akt 1.pdf" in second.calls[0]
        assert folder.cards[("proj", "Akten")]["abstract"] == "Akten des Projekts."
        assert _increments() == 1

    def test_names_removed_matches_file_name_or_stem_but_not_short_stems(self):
        assert worker.names_removed("Enthält das Brandschutzgutachten.", ["Brandschutzgutachten.pdf"])
        assert worker.names_removed("Siehe Plan.pdf", ["Plan.pdf"])
        assert not worker.names_removed("Ein Ordner mit Plänen.", ["A.pdf", "Statik.pdf"])

    async def test_the_tenth_increment_is_followed_by_a_full_build_that_resets_the_counter(self, folder):
        model = FakeModel(_card)
        await worker.run_once(llm=model)
        for round_ in range(incremental.MAX_INCREMENTS):
            factory.register_summary("proj", "Akt 6.pdf", f"Fassung {round_}.")
            await worker.run_once(llm=model)
        assert _increments() == incremental.MAX_INCREMENTS

        factory.register_summary("proj", "Akt 6.pdf", "Noch einmal.")
        await worker.run_once(llm=model)

        assert "## Documents directly in this folder (6)" in model.calls[-1]
        assert _increments() == 0

    async def test_a_large_change_is_a_full_build(self, folder):
        model = FakeModel(_card)
        await worker.run_once(llm=model)
        for name in NAMES[:4]:
            factory.register_summary("proj", name, "Alles neu.")

        await worker.run_once(llm=model)

        assert "## Documents directly in this folder (6)" in model.calls[-1]

    async def test_the_trace_says_the_mode_and_the_diff(self, folder):
        model = FakeModel(_card)
        await worker.run_once(llm=model)
        factory.register_summary("proj", "Akt 4.pdf", "Neu.")
        direct_trace.reset_tracer_provider()
        exporter = InMemorySpanExporter()
        direct_trace.install_tracer_provider(None, env={}, exporter=exporter)
        try:
            await worker.run_once(llm=model)
            direct_trace._provider.force_flush()
        finally:
            direct_trace.reset_tracer_provider()

        (span,) = exporter.get_finished_spans()
        assert span.attributes["langfuse.trace.name"] == build.GENERATION_NAME
        assert span.attributes["langfuse.trace.metadata.mode"] == "incremental"
        assert span.attributes["langfuse.trace.metadata.diff_changed"] == 1
        assert span.attributes["langfuse.trace.metadata.diff_added"] == 0
