"""The written card: the validator drops what cites no child, the bounds hold, and the call is a Langfuse generation."""

from __future__ import annotations

import pytest
from agent_testing.folder_cards import FakeModel
from knowledge_layer.browse import file_rows
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from agent.knowledge.folder_cards import build
from agent.knowledge.folder_cards.inputs import MAX_LISTED_DOCUMENTS
from agent.knowledge.folder_cards.inputs import folder_inputs
from agent.observability import direct_trace

ROWS = [
    {"file_name": "BS-Gutachten.pdf", "folder_path": "Gutachten", "collection": "proj", "summary": "Brandschutz."},
    {"file_name": "Statik.pdf", "folder_path": "Gutachten", "collection": "proj", "summary": "Statik."},
    {"file_name": "Schall.pdf", "folder_path": "Gutachten", "collection": "proj", "summary": "Schall."},
    {"file_name": "Bescheid.pdf", "folder_path": "Gutachten/Behörde", "collection": "proj", "summary": "Bescheid."},
]
INPUTS = folder_inputs("proj", "Gutachten", file_rows(ROWS), {})


def _reply(abstract="Gutachten zum Wohnhaus.", facts=()):
    return build.CardReply.model_validate({"abstract": abstract, "key_facts": list(facts)})


def _fact(statement, *documents, pages=None):
    return {"statement": statement, "documents": list(documents), "pages": pages}


class TestValidate:
    def test_a_fact_citing_a_child_survives_with_the_childs_exact_name(self):
        draft = build.validate(_reply(facts=[_fact("Brandschutz liegt vor.", "bs-gutachten.PDF", pages="4-6")]), INPUTS)

        assert [fact.wire() for fact in draft.key_facts] == [
            {"statement": "Brandschutz liegt vor.", "documents": ["BS-Gutachten.pdf"], "pages": "4-6"}
        ]

    @pytest.mark.parametrize(
        "documents",
        [["Erfunden.pdf"], ["BS-Gutachten.pdf", "Erfunden.pdf"], ["Bescheid.pdf"], []],
        ids=["invented", "one-of-two-invented", "a-grandchild", "no-citation"],
    )
    def test_a_fact_that_cites_anything_but_a_direct_child_is_dropped(self, documents):
        draft = build.validate(_reply(facts=[_fact("Eine Behauptung.", *documents)]), INPUTS)

        assert (draft.key_facts, draft.dropped_facts) == ((), 1)

    def test_at_most_eight_facts(self):
        facts = [_fact(f"Fakt {n}.", "Statik.pdf") for n in range(12)]

        assert len(build.validate(_reply(facts=facts), INPUTS).key_facts) == build.MAX_KEY_FACTS

    def test_the_abstract_is_cut_to_three_sentences_without_splitting_an_abbreviation(self):
        abstract = "Gutachten z. B. zum Brandschutz. Zweiter Satz. Dritter Satz! Vierter Satz."

        draft = build.validate(_reply(abstract=abstract), INPUTS)

        assert draft.abstract == "Gutachten z. B. zum Brandschutz. Zweiter Satz. Dritter Satz!"

    def test_the_abstract_and_a_statement_stay_inside_the_contracts_bounds(self):
        draft = build.validate(_reply(abstract="Wort " * 400, facts=[_fact("lang " * 200, "Statik.pdf")]), INPUTS)

        assert len(draft.abstract) <= build.MAX_ABSTRACT_CHARS
        assert len(draft.key_facts[0].statement) <= build.MAX_STATEMENT_CHARS

    def test_no_abstract_is_no_card(self):
        with pytest.raises(ValueError):
            build.validate(_reply(abstract="   "), INPUTS)

    def test_the_abstract_hash_ignores_whitespace(self):
        assert build.abstract_hash("Ein  Ordner.\n") == build.abstract_hash("Ein Ordner.")


class TestPrompt:
    def test_the_prompt_lists_children_and_marks_the_data(self):
        prompt = build.user_prompt(INPUTS)

        assert prompt.startswith("## Folder\nGutachten")
        assert "- BS-Gutachten.pdf" in prompt and "Brandschutz." in prompt
        assert "- Behörde/: holds Bescheid.pdf" in prompt

    def test_a_huge_flat_folder_is_bounded(self):
        many = [
            {"file_name": f"Plan {n:03}.pdf", "folder_path": "Pläne", "collection": "proj", "summary": "Ein Plan."}
            for n in range(MAX_LISTED_DOCUMENTS + 40)
        ]
        prompt = build.user_prompt(folder_inputs("proj", "Pläne", file_rows(many), {}))

        assert prompt.count("\n- Plan ") == MAX_LISTED_DOCUMENTS
        assert "… and 40 more, not listed" in prompt


@pytest.fixture
def exporter():
    direct_trace.reset_tracer_provider()
    memory = InMemorySpanExporter()
    direct_trace.install_tracer_provider(None, env={}, exporter=memory)
    yield memory
    direct_trace.reset_tracer_provider()


class TestGenerate:
    async def test_the_call_is_a_langfuse_generation_with_usage_and_metadata(self, exporter):
        model = FakeModel(lambda prompt: {"abstract": "Gutachten.", "key_facts": []})

        generation = await build.generate(INPUTS, model)

        assert generation.reply.abstract == "Gutachten."
        assert generation.tokens == 1100
        assert generation.model == "test/summary-model"
        assert model.bound[0]["response_format"]["type"] == "json_schema"
        # The summary model is capped at one sentence; a card with key facts needs its own budget.
        assert model.bound[0]["max_tokens"] == build.MAX_OUTPUT_TOKENS >= 1000
        direct_trace._provider.force_flush()
        (span,) = exporter.get_finished_spans()
        assert span.attributes["langfuse.trace.name"] == build.GENERATION_NAME
        assert span.attributes["langfuse.observation.type"] == "generation"
        assert span.attributes["gen_ai.usage.input_tokens"] == 1000
        assert span.attributes["langfuse.trace.metadata.collection"] == "proj"
        assert span.attributes["langfuse.trace.metadata.depth"] == 1

    async def test_a_reply_that_is_not_json_fails_the_generation(self, exporter):
        model = FakeModel()

        async def broken(messages):
            from langchain_core.messages import AIMessage

            return AIMessage(content="kein JSON")

        model.ainvoke = broken
        with pytest.raises(ValueError):
            await build.generate(INPUTS, model)
        direct_trace._provider.force_flush()
        (span,) = exporter.get_finished_spans()
        assert span.attributes["langfuse.observation.level"] == "ERROR"
