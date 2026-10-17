"""A region of a page, rendered alone: the box a person drew on the review canvas.

The PDFs here are real ones, built with pypdfium2, with a red square in a known
corner. That is what pins the two facts the crop maths rests on and pypdfium2
only states in a docstring: ``page.get_size()`` is the page as shown (its
``/Rotate`` applied), and ``render(crop=...)`` cuts points off the edges of that
shown page, scaled and rounded up, allocating only what is left.
"""

from __future__ import annotations

import io

import knowledge_layer.llamaindex.adapter as llm_adapter
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
import pytest
from PIL import Image

from aiq_agent.common import image_view_budget
from aiq_agent.common import model_vision
from sources.knowledge_layer.src import view_image as view
from sources.knowledge_layer.src.view_image import ViewLimits
from sources.knowledge_layer.src.view_image import _crop_image_region
from sources.knowledge_layer.src.view_image import _render_pdf_region
from sources.knowledge_layer.src.view_image import parse_region
from sources.knowledge_layer.src.view_image import region_render_args

A4 = (595.0, 842.0)
A0 = (2384.0, 3370.0)
RED = (255, 0, 0)
WHITE = (255, 255, 255)


def _pdf(width: float, height: float, rotation: int = 0) -> bytes:
    """One page, a red square on the top-left quarter of the page as stored (PDF y runs up)."""
    doc = pdfium.PdfDocument.new()
    page = doc.new_page(width, height)
    square = pdfium_c.FPDFPageObj_CreateNewRect(0, height * 0.75, width * 0.25, height * 0.25)
    pdfium_c.FPDFPageObj_SetFillColor(square, 255, 0, 0, 255)
    pdfium_c.FPDFPath_SetDrawMode(square, pdfium_c.FPDF_FILLMODE_ALTERNATE, False)
    pdfium_c.FPDFPage_InsertObject(page, square)
    pdfium_c.FPDFPage_GenerateContent(page)
    if rotation:
        page.set_rotation(rotation)
    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


def _image(jpeg: bytes) -> Image.Image:
    return Image.open(io.BytesIO(jpeg)).convert("RGB")


def _near(pixel: tuple[int, ...], colour: tuple[int, int, int]) -> bool:
    return all(abs(a - b) < 40 for a, b in zip(pixel[:3], colour, strict=True))


def _centre(image: Image.Image) -> tuple[int, ...]:
    return image.getpixel((image.width // 2, image.height // 2))


# ---------------------------------------------------------------------------
# The maths
# ---------------------------------------------------------------------------


def test_the_crop_cuts_each_edge_of_the_shown_page_in_points():
    scale, crop = region_render_args((0.1, 0.2, 0.5, 0.25), *A4, max_dim=2048)

    left, bottom, right, top = crop
    assert left == pytest.approx(59.5)
    assert top == pytest.approx(168.4)
    assert right == pytest.approx(595 - 59.5 - 297.5)
    assert bottom == pytest.approx(842 - 168.4 - 210.5)
    # The long edge of the box (297.5 pt wide) lands on max_dim pixels.
    assert scale * 297.5 == pytest.approx(2048)


def test_a_tiny_box_is_widened_about_its_centre_and_the_scale_is_capped():
    scale, crop = region_render_args((0.5, 0.5, 0.001, 0.001), *A4, max_dim=2048)

    left, bottom, right, top = crop
    assert 595 - left - right == pytest.approx(view._MIN_REGION_PT)
    assert 842 - top - bottom == pytest.approx(view._MIN_REGION_PT)
    assert left + view._MIN_REGION_PT / 2 == pytest.approx(0.5005 * 595)
    assert scale == pytest.approx(view._MAX_REGION_SCALE)


def test_a_tiny_box_at_the_edge_stays_on_the_page():
    _, (left, bottom, right, top) = region_render_args((0.999, 0.0, 0.001, 0.001), *A4, max_dim=2048)

    assert right == pytest.approx(0.0)
    assert top == pytest.approx(0.0)
    assert left == pytest.approx(595 - view._MIN_REGION_PT)


@pytest.mark.parametrize(
    "value",
    [
        None,
        [0.1, 0.1, 0.2],
        [0.1, 0.1, 0.2, 0.2, 0.2],
        ["a", 0.1, 0.2, 0.2],
        [-0.1, 0.1, 0.2, 0.2],
        [0.1, 0.1, 0.0, 0.2],
        [0.1, 0.1, 0.2, -0.2],
        [0.9, 0.1, 0.2, 0.2],
        [0.1, 0.9, 0.2, 0.2],
        [float("nan"), 0.1, 0.2, 0.2],
        [12, 40, 200, 100],
    ],
)
def test_an_invalid_region_is_refused_with_the_frame_it_should_have(value):
    with pytest.raises(ValueError, match=r"\[x, y, w, h\]"):
        parse_region(value)


def test_a_box_flush_with_the_edge_survives_float_rounding():
    assert parse_region([0.3, 0.0, 0.7000000000000001, 1.0]) == pytest.approx((0.3, 0.0, 0.7, 1.0))


# ---------------------------------------------------------------------------
# Real pages
# ---------------------------------------------------------------------------


def test_the_top_left_box_of_an_upright_page_is_the_red_square():
    jpeg, width, height, widened = _render_pdf_region(_pdf(*A4), 1, (0.0, 0.0, 0.25, 0.25), 2048)

    image = _image(jpeg)
    assert (width, height) == image.size
    assert max(width, height) == pytest.approx(2048, abs=2)
    assert not widened
    assert _near(_centre(image), RED)
    assert _near(image.getpixel((5, 5)), RED)


def test_a_box_beside_the_square_shows_none_of_it():
    jpeg, *_ = _render_pdf_region(_pdf(*A4), 1, (0.5, 0.0, 0.25, 0.25), 2048)

    assert _near(_centre(_image(jpeg)), WHITE)


@pytest.mark.parametrize(
    ("rotation", "box"),
    [
        # The square sits top left as stored; turned clockwise it is shown top right,
        # then bottom right, then bottom left. The box is drawn on the page as shown.
        (90, (0.75, 0.0, 0.25, 0.25)),
        (180, (0.75, 0.75, 0.25, 0.25)),
        (270, (0.0, 0.75, 0.25, 0.25)),
    ],
)
def test_a_rotated_page_is_cropped_as_it_is_shown(rotation, box):
    data = _pdf(*A4, rotation=rotation)

    shown, *_ = _render_pdf_region(data, 1, box, 1024)
    stored_corner, *_ = _render_pdf_region(data, 1, (0.0, 0.0, 0.25, 0.25), 1024)

    assert _near(_centre(_image(shown)), RED)
    assert _near(_centre(_image(stored_corner)), WHITE)


def test_a_rotated_page_keeps_the_proportions_of_the_shown_box():
    _, width, height, _ = _render_pdf_region(_pdf(*A4, rotation=90), 1, (0.0, 0.0, 0.5, 0.25), 1024)

    # Shown, the page is 842 wide and 595 high: half its width is 421 pt, a
    # quarter of its height 148.75 pt.
    assert width / height == pytest.approx(421 / 148.75, rel=0.02)


def test_a_tiny_box_still_renders_and_says_it_was_widened():
    jpeg, width, height, widened = _render_pdf_region(_pdf(*A4), 1, (0.1, 0.1, 0.0005, 0.0005), 2048)

    assert widened
    expected = round(view._MIN_REGION_PT * view._MAX_REGION_SCALE)
    assert abs(width - expected) <= 2 and abs(height - expected) <= 2
    assert _near(_centre(_image(jpeg)), RED)


def test_a_huge_page_never_allocates_the_whole_sheet(monkeypatch):
    allocated: list[tuple[int, int]] = []
    native = pdfium.PdfBitmap.new_native

    def spy(width, height, *args, **kwargs):
        allocated.append((width, height))
        return native(width, height, *args, **kwargs)

    monkeypatch.setattr(pdfium.PdfBitmap, "new_native", spy)

    _, width, height, _ = _render_pdf_region(_pdf(*A0), 1, (0.4, 0.4, 0.05, 0.05), 2048)

    # The whole A0 sheet at the box's scale would be about 17 000 x 24 000 px.
    assert allocated == [(width, height)]
    assert max(allocated[0]) <= 2050


def test_a_page_that_does_not_exist_raises_for_the_caller_to_word():
    with pytest.raises(Exception, match="page"):
        _render_pdf_region(_pdf(*A4), 3, (0.0, 0.0, 0.5, 0.5), 512)


def test_an_uploaded_image_is_cropped_to_the_box():
    picture = Image.new("RGB", (400, 200), WHITE)
    picture.paste(Image.new("RGB", (100, 50), RED), (300, 150))
    buffer = io.BytesIO()
    picture.save(buffer, format="PNG")

    jpeg, width, height, widened = _crop_image_region(buffer.getvalue(), (0.75, 0.75, 0.25, 0.25), 2048)

    assert (width, height) == (100, 50)
    assert not widened
    assert _near(_centre(_image(jpeg)), RED)


# ---------------------------------------------------------------------------
# Through the tool's body
# ---------------------------------------------------------------------------


@pytest.fixture
def _viewable(monkeypatch, tmp_path):
    monkeypatch.setenv("AIQ_VIEW_IMAGES_ENABLED", "true")
    monkeypatch.setattr(llm_adapter, "_get_vlm_api_key", lambda: "sk-test")
    path = tmp_path / "Grundriss_EG.pdf"
    path.write_bytes(_pdf(*A4))
    monkeypatch.setattr(view, "_find_pdf", lambda _name: str(path))
    model_vision.reset_catalog_cache()
    yield
    model_vision.reset_catalog_cache()


@pytest.mark.usefixtures("_viewable")
async def test_a_region_view_returns_the_crop_and_counts_as_a_region_look():
    token = image_view_budget.begin_image_view_budget()
    try:
        result = await view.view_image("Grundriss_EG.pdf", 1, region=[0.0, 0.0, 0.25, 0.25], limits=ViewLimits())
        budget = image_view_budget.get_image_view_budget()
        assert budget is not None and budget.regions_viewed == 1 and budget.used == 1
    finally:
        image_view_budget.end_image_view_budget(token)

    assert isinstance(result, list)
    assert result[0]["text"].startswith("Region [x=0.000, y=0.000, w=0.250, h=0.250]")
    assert result[1]["type"] == "image_url"


@pytest.mark.usefixtures("_viewable")
async def test_an_invalid_region_costs_no_view():
    token = image_view_budget.begin_image_view_budget()
    try:
        result = await view.view_image("Grundriss_EG.pdf", 1, region=[0.9, 0.1, 0.2, 0.2], tool="look")
        budget = image_view_budget.get_image_view_budget()
        assert budget is not None and budget.used == 0
    finally:
        image_view_budget.end_image_view_budget(token)

    assert isinstance(result, str)
    assert result.startswith("[look] Invalid region")


@pytest.mark.usefixtures("_viewable")
async def test_a_model_that_takes_no_images_is_told_so_instead_of_breaking_the_turn(monkeypatch):
    monkeypatch.setattr(model_vision, "_fetch_catalog", lambda: {"some/text-model": False})
    token = image_view_budget.begin_image_view_budget()
    try:
        with model_vision.chat_model_scope("some/text-model"):
            result = await view.view_image("Grundriss_EG.pdf", 1, region=[0.0, 0.0, 0.5, 0.5])
        budget = image_view_budget.get_image_view_budget()
        assert budget is not None and budget.used == 0
    finally:
        image_view_budget.end_image_view_budget(token)

    assert isinstance(result, str)
    assert "takes no images" in result


@pytest.mark.usefixtures("_viewable")
async def test_a_model_the_catalog_does_not_know_still_gets_the_image(monkeypatch):
    monkeypatch.setattr(model_vision, "_fetch_catalog", lambda: {})

    with model_vision.chat_model_scope("byok/own-model"):
        result = await view.view_image("Grundriss_EG.pdf", 1, region=[0.0, 0.0, 0.5, 0.5])

    assert isinstance(result, list)
