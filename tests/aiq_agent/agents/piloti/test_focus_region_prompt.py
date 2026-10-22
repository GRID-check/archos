"""The „Focus region“: the box a person drew on the review canvas, as the model reads it.

What is load-bearing: it reaches the prompt at all, below the KV-cache boundary
(it varies per question); it names the document, page and box in words a person
would use; it sends the model to look at exactly that crop before it answers;
and a question asked in a thread is answered there by the model's own
`canvas__reply`, because nothing posts for it.
"""

import re

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import focus_region_block
from aiq_agent.agents.piloti.prompt import render_turn_context
from aiq_agent.agents.piloti.prompt import system_prompt_template
from aiq_agent.common.wire_v2 import FocusRegion

HEADING = "## Focus region"
BOUNDARY_ANCHOR = "<turn_context>"
CANVAS = [{"name": "look", "description": "x"}] + [
    {"name": f"canvas__{tool}", "description": "x"} for tool in ("highlight", "point", "mark", "reply")
]
CANVAS_NAMES = [tool["name"] for tool in CANVAS]
WITHOUT_CANVAS = ["look"]
REGION = FocusRegion(page=2, x=0.05, y=0.1, w=0.25, h=0.2)
IN_A_THREAD = FocusRegion(page=3, x=0.8, y=0.7, w=0.1, h=0.1, annotation_id="33333333-0000-4000-8000-000000000003")
#: test_product_framing.py's rule: a file is never a plan.
FILE_AS_PLAN = re.compile(r"(?<![\w-])(Plan|Pläne|Plänen|Planstand|Planstände|Planständen)(?![\w-])")


def _state(**fields) -> ResearchAgentState:
    return ResearchAgentState(messages=[HumanMessage(content="Ist das breit genug?")], **fields)


def _render(tools=CANVAS, **fields) -> str:
    return render_turn_context(system_prompt_template(), _state(**fields), tools)


class TestTheBlockReachesTheModel:
    def test_a_box_renders_its_section_below_the_cache_boundary(self):
        rendered = _render(focus_file_name="Grundriss_EG.pdf", focus_region=REGION)

        assert HEADING in rendered
        assert rendered.index(BOUNDARY_ANCHOR) < rendered.index(HEADING)

    def test_no_box_renders_no_section(self):
        assert HEADING not in _render(focus_file_name="Grundriss_EG.pdf")


class TestWhatItSays:
    def test_it_names_the_document_page_and_box_in_words(self):
        block = focus_region_block(_state(focus_file_name="Grundriss_EG.pdf", focus_region=REGION), CANVAS_NAMES)

        assert "page 2 of **Grundriss_EG.pdf**" in block
        assert "top left" in block
        assert "25 % of the page width and 20 % of the page height" in block
        assert "region=[0.050, 0.100, 0.250, 0.200]" in block

    def test_it_sends_the_model_to_look_at_the_crop_before_answering(self):
        block = focus_region_block(_state(focus_region=REGION), CANVAS_NAMES)

        assert "before you answer: `look` with `page=2` and `region=[0.050, 0.100, 0.250, 0.200]`" in block
        assert "page 2 of the open document" in block

    def test_it_names_the_document_to_look_at_when_it_knows_it(self):
        block = focus_region_block(_state(focus_file_name="A.pdf", focus_region=REGION), CANVAS_NAMES)

        assert '`look` with `document="A.pdf"`, `page=2` and `region=' in block

    def test_without_the_canvas_tools_it_still_looks_and_asks_for_no_canvas_work(self):
        block = focus_region_block(_state(focus_file_name="A.pdf", focus_region=REGION), WITHOUT_CANVAS)

        assert '`look` with `document="A.pdf"`, `page=2`' in block
        assert "canvas__" not in block

    def test_a_thread_question_asks_the_model_to_answer_there_itself(self):
        block = focus_region_block(_state(focus_region=IN_A_THREAD, reply_in_thread=True), CANVAS_NAMES)

        assert "`canvas__reply`" in block and IN_A_THREAD.annotation_id in block
        assert "bottom right" in block

    def test_a_box_alone_asks_for_no_reply(self):
        assert "canvas__reply" not in focus_region_block(_state(focus_region=IN_A_THREAD), CANVAS_NAMES)

    def test_a_model_that_cannot_see_is_told_not_to_guess(self):
        assert "do not guess" in focus_region_block(_state(focus_region=REGION), CANVAS_NAMES)

    def test_it_never_calls_a_file_a_plan(self):
        for state in (_state(focus_region=REGION), _state(focus_region=IN_A_THREAD, reply_in_thread=True)):
            for tools in (CANVAS_NAMES, WITHOUT_CANVAS):
                assert not FILE_AS_PLAN.search(focus_region_block(state, tools) or "")
