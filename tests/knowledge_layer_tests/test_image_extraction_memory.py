"""An image-heavy document is capped before it is decoded, and decoded one raster at a time.

The ingest worker's memory used to grow with the document: every embedded raster
of every page was decoded at full resolution, and the detached PIL copies were
held in a list until the file ended. Two pods were OOM-killed (exit 137) in the
visual-analysis phase on a plan set. Three properties are pinned here so it
cannot come back:

- the per-document cap is applied to image metadata, so an image that will not
  be analysed is never decoded at all;
- a raster over the per-raster pixel budget (``AIQ_MAX_IMAGE_PIXELS``) is
  refused from its metadata too, so a pathological raster never allocates a
  full-resolution bitmap in the first place;
- a raster's full-resolution bitmap is closed before the next one is opened, so
  the peak is one raster, not the sum of the document's rasters;
- a downscaled or untouched raster owns its pixels, because ``PdfBitmap.to_pil``
  hands back a view over the bitmap's buffer that dies with it.

The first-page render is pinned too: it exists to make a 400 px thumbnail, and a
fixed ``scale=2`` rendered an A0 sheet at ~6740 px -- ~100 MB of pixels, copied
again to leave the lock -- to throw nearly all of it away.
"""

from __future__ import annotations

import pypdfium2 as pdfium
import pytest
from knowledge_layer.llamaindex import adapter
from PIL import Image

# =============================================================================
# Fakes that make the decodes countable
# =============================================================================


class _DecodeLedger:
    """Every bitmap the extraction opens, and how many are open at once."""

    def __init__(self) -> None:
        self.opened: list[tuple[int, int]] = []
        self.closed = 0
        self.open_now = 0
        self.high_water = 0

    def opened_bitmap(self, size: tuple[int, int]) -> None:
        self.opened.append(size)
        self.open_now += 1
        self.high_water = max(self.high_water, self.open_now)

    def closed_bitmap(self) -> None:
        self.closed += 1
        self.open_now -= 1


class _Bitmap:
    def __init__(self, size: tuple[int, int], ledger: _DecodeLedger, color: tuple[int, int, int] = (0, 0, 0)) -> None:
        self.width, self.height = size
        self._ledger = ledger
        self._color = color
        ledger.opened_bitmap(size)

    def to_pil(self):
        return Image.new("RGB", (self.width, self.height), self._color)

    def close(self) -> None:
        self._ledger.closed_bitmap()


class _ImageObject:
    """One image XObject with countable metadata reads and decodes."""

    type = 3  # FPDF_PAGEOBJ_IMAGE

    def __init__(
        self,
        size: tuple[int, int],
        ledger: _DecodeLedger,
        *,
        metadata: bool = True,
        decodable: bool = True,
        color: tuple[int, int, int] = (0, 0, 0),
    ) -> None:
        self.size = size
        self.sized_calls = 0
        self._ledger = ledger
        self._metadata = metadata
        self._decodable = decodable
        self._color = color

    def get_px_size(self) -> tuple[int, int]:
        self.sized_calls += 1
        if not self._metadata:
            raise RuntimeError("no image metadata in this stream")
        return self.size

    def get_bitmap(self) -> _Bitmap:
        if not self._decodable:
            raise RuntimeError("unsupported image filter")
        return _Bitmap(self.size, self._ledger, self._color)


class _Page:
    def __init__(self, objects: list[object]) -> None:
        self._objects = objects

    def get_objects(self) -> list[object]:
        return list(self._objects)

    def close(self) -> None:
        pass


class _Document:
    def __init__(self, pages: list[_Page]) -> None:
        self._pages = pages

    def __len__(self) -> int:
        return len(self._pages)

    def __getitem__(self, index: int) -> _Page:
        return self._pages[index]

    def close(self) -> None:
        pass


class _RenderPage:
    """A page that records the scale it was rendered at; ``to_pil`` returns real pixels."""

    def __init__(self, page_size: tuple[float, float], record: dict[str, float]) -> None:
        self._page_size = page_size
        self._record = record

    def get_size(self) -> tuple[float, float]:
        return self._page_size

    def render(self, scale: float) -> _Bitmap:
        self._record["scale"] = scale
        return _Bitmap((4, 4), _DecodeLedger())

    def close(self) -> None:
        pass


class _RenderDocument:
    def __init__(self, page_size: tuple[float, float]) -> None:
        self.record: dict[str, float] = {}
        self._page = _RenderPage(page_size, self.record)

    def __getitem__(self, index: int) -> _RenderPage:
        return self._page

    def close(self) -> None:
        pass


@pytest.fixture
def ledger() -> _DecodeLedger:
    return _DecodeLedger()


def _install(monkeypatch: pytest.MonkeyPatch, document: object) -> None:
    monkeypatch.setattr(pdfium, "PdfDocument", lambda _path: document)


def _extract_records(**overrides: object) -> tuple[list[dict], int, int]:
    kwargs: dict[str, object] = {
        "min_width": 100,
        "min_height": 100,
        "skip_pages": frozenset(),
        "max_images": None,
        "max_pixels": adapter.MAX_IMAGE_PIXELS,
    }
    kwargs.update(overrides)
    return adapter._extract_image_records("ignored.pdf", **kwargs)  # type: ignore[arg-type]


def _extract(**overrides: object) -> tuple[list[dict], int]:
    """Records and the cap's left-outs; the pixel-budget refusals are dropped (use ``_extract_records``)."""
    records, over_cap, _ = _extract_records(**overrides)
    return records, over_cap


# =============================================================================
# The cap runs on metadata: an unanalysed image is never decoded
# =============================================================================


def test_the_cap_is_applied_before_any_raster_is_decoded(monkeypatch, ledger) -> None:
    """Ten rasters and a cap of three: the three largest are decoded, and no others."""
    pages = [
        _Page([_ImageObject((1000 + index * 100, 1000 + index * 100), ledger, color=(index * 20, 0, 0))])
        for index in range(10)
    ]
    _install(monkeypatch, _Document(pages))

    records, over_cap = _extract(max_images=3)

    assert over_cap == 7
    assert sorted(ledger.opened) == [(1700, 1700), (1800, 1800), (1900, 1900)]
    # ...and they come back in document order, so stored-image indices stay stable
    assert [record["page_number"] for record in records] == [8, 9, 10]


def test_a_cap_of_none_reads_no_raster(monkeypatch, ledger) -> None:
    """``AIQ_MAX_IMAGES_PER_DOCUMENT=0`` analyses none, so it decodes none."""
    _install(monkeypatch, _Document([_Page([_ImageObject((2000, 2000), ledger)])]))

    records, over_cap = _extract(max_images=0)

    assert (records, over_cap) == ([], 1)
    assert ledger.opened == []


def test_small_rasters_are_filtered_on_metadata_alone(monkeypatch, ledger) -> None:
    """An icon is rejected without a pixel being decoded."""
    _install(monkeypatch, _Document([_Page([_ImageObject((40, 40), ledger)])]))

    records, over_cap = _extract()

    assert (records, over_cap) == ([], 0)
    assert ledger.opened == []


def test_a_rendered_page_contributes_no_raster_and_no_metadata_read(monkeypatch, ledger) -> None:
    """A page already analysed whole as a visual page costs nothing here, not even a size."""
    skipped = _ImageObject((2000, 2000), ledger)
    _install(monkeypatch, _Document([_Page([skipped]), _Page([_ImageObject((1500, 1500), ledger)])]))

    records, _ = _extract(skip_pages=frozenset({1}))

    assert [record["page_number"] for record in records] == [2]
    assert skipped.sized_calls == 0


def test_an_image_without_metadata_is_sized_by_decoding_it(monkeypatch, ledger) -> None:
    """A stream (or a library) that cannot report a size keeps the old behaviour."""
    _install(monkeypatch, _Document([_Page([_ImageObject((1200, 900), ledger, metadata=False)])]))

    records, _ = _extract()

    assert [(record["width"], record["height"]) for record in records] == [(1200, 900)]
    # once to size it, once to analyse it
    assert ledger.opened == [(1200, 900), (1200, 900)]


def test_an_unreadable_raster_does_not_lose_its_page(monkeypatch, ledger) -> None:
    """One unsupported image is skipped; the rest of the page and the document still come back."""
    broken = _ImageObject((900, 900), ledger, decodable=False)
    _install(
        monkeypatch,
        _Document(
            [
                _Page([_ImageObject((1000, 1000), ledger), broken]),
                _Page([_ImageObject((800, 800), ledger)]),
            ]
        ),
    )

    records, _ = _extract()

    assert [record["page_number"] for record in records] == [1, 2]


def test_identical_rasters_are_still_deduped(monkeypatch, ledger) -> None:
    """The same raster embedded twice is captioned and indexed once."""
    _install(
        monkeypatch,
        _Document([_Page([_ImageObject((800, 800), ledger), _ImageObject((800, 800), ledger)])]),
    )

    records, _ = _extract()

    assert len(records) == 1


# =============================================================================
# The per-raster pixel budget: a pathological raster is never decoded
# =============================================================================


def test_an_over_budget_raster_is_refused_before_it_is_decoded(monkeypatch, ledger) -> None:
    """A 20000x20000 px raster (~400 MP, ~1.6 GiB) is refused on metadata; the ordinary one is read."""
    _install(
        monkeypatch,
        _Document([_Page([_ImageObject((20000, 20000), ledger), _ImageObject((800, 600), ledger, color=(0, 20, 0))])]),
    )

    records, _, over_pixel_budget = _extract_records()

    assert over_pixel_budget == 1
    # the only bitmap opened is the raster that was kept: the refused one never allocated
    assert ledger.opened == [(800, 600)]
    assert [(record["width"], record["height"]) for record in records] == [(800, 600)]


def test_a_raster_exactly_at_the_budget_is_decoded(monkeypatch, ledger) -> None:
    """The budget is a ceiling, not a floor: width x height == max_pixels is inside it."""
    _install(monkeypatch, _Document([_Page([_ImageObject((2000, 2000), ledger)])]))

    records, _, over_pixel_budget = _extract_records(max_pixels=4_000_000)

    assert over_pixel_budget == 0
    assert ledger.opened == [(2000, 2000)]
    assert len(records) == 1


def test_one_pixel_over_the_budget_is_refused(monkeypatch, ledger) -> None:
    """One pixel past the ceiling is out, so the boundary is the number the env var states."""
    _install(monkeypatch, _Document([_Page([_ImageObject((2001, 2000), ledger)])]))

    records, _, over_pixel_budget = _extract_records(max_pixels=4_000_000)

    assert over_pixel_budget == 1
    assert records == []
    assert ledger.opened == []


def test_the_default_budget_admits_a_300_dpi_a0_scan(monkeypatch, ledger) -> None:
    """The default is generous to real plans: A0 at 300 dpi (9933x14043 px, ~139.5 MP) is kept."""
    _install(monkeypatch, _Document([_Page([_ImageObject((9933, 14043), ledger)])]))

    records, _, over_pixel_budget = _extract_records()

    assert over_pixel_budget == 0
    assert len(records) == 1


def test_a_metadata_less_over_budget_raster_costs_only_its_sizing_decode(monkeypatch, ledger) -> None:
    """Without metadata there is no size but the decode: it is sized once, then refused and not analysed."""
    _install(monkeypatch, _Document([_Page([_ImageObject((20000, 20000), ledger, metadata=False)])]))

    records, _, over_pixel_budget = _extract_records()

    assert over_pixel_budget == 1
    assert records == []
    # one decode, to read the size the stream would not report -- never a second to analyse it
    assert ledger.opened == [(20000, 20000)]


def test_the_refusal_count_survives_the_analysis_wrapper(monkeypatch, ledger) -> None:
    """``_embedded_images_for_analysis`` carries the refusal count the caller records on the job status."""
    _install(monkeypatch, _Document([_Page([_ImageObject((20000, 20000), ledger), _ImageObject((700, 700), ledger)])]))

    images, over_cap, over_pixel_budget = adapter._embedded_images_for_analysis(
        "ignored.pdf", rendered_pages=set(), enabled=True
    )

    assert (over_cap, over_pixel_budget) == (0, 1)
    assert [(image["width"], image["height"]) for image in images] == [(700, 700)]


def test_a_page_that_skips_extraction_costs_no_budget_check(monkeypatch, ledger) -> None:
    """A rendered or scanned page is analysed whole; its rasters are neither sized nor refused."""
    skipped = _ImageObject((20000, 20000), ledger)
    _install(monkeypatch, _Document([_Page([skipped]), _Page([_ImageObject((700, 700), ledger)])]))

    records, _, over_pixel_budget = _extract_records(skip_pages=frozenset({1}))

    assert over_pixel_budget == 0
    assert [record["page_number"] for record in records] == [2]
    assert skipped.sized_calls == 0


# =============================================================================
# One raster in flight: the peak does not grow with the document
# =============================================================================


def test_only_one_full_resolution_raster_is_open_at_a_time(monkeypatch, ledger) -> None:
    """Twelve distinct rasters across three pages: never two bitmaps alive together, none left open."""
    pages = [
        _Page([_ImageObject((1600, 1600), ledger, color=((page_index * 4 + index) * 20, 0, 0)) for index in range(4)])
        for page_index in range(3)
    ]
    _install(monkeypatch, _Document(pages))

    records, _ = _extract()

    assert len(records) == 12
    assert ledger.high_water == 1
    assert ledger.open_now == 0
    assert ledger.closed == len(ledger.opened)


def test_a_downscaled_raster_outlives_the_bitmap_it_came_from(monkeypatch, ledger) -> None:
    """``to_pil()`` is a view over the bitmap's buffer: after the bitmap closes, the pixels must still be there."""
    with adapter.pdfium_lock():
        image = adapter._downscaled_raster(_ImageObject((3200, 1600), ledger))

    assert image.size == (adapter.VLM_MAX_IMAGE_DIM, adapter.VLM_MAX_IMAGE_DIM // 2)
    assert image.getpixel((0, 0)) == (0, 0, 0)


def test_an_untouched_raster_is_detached_from_its_bitmap(monkeypatch, ledger) -> None:
    """An image already within bounds is not resized, so it is detached explicitly."""
    with adapter.pdfium_lock():
        image = adapter._downscaled_raster(_ImageObject((400, 300), ledger))

    assert image.size == (400, 300)
    assert image.getpixel((0, 0)) == (0, 0, 0)


# =============================================================================
# The first-page render is clamped like every other page render
# =============================================================================


def test_the_first_page_render_is_clamped_to_the_page_render_bound(monkeypatch) -> None:
    """An A0 sheet is rendered near the page bound, not at |scale| x its own size."""
    document = _RenderDocument((2384.0, 3370.0))
    _install(monkeypatch, document)

    adapter._render_first_pdf_page("ignored.pdf", scale=2)

    assert document.record["scale"] == pytest.approx(adapter.PAGE_RENDER_MAX_DIM / 3370.0)


def test_an_ordinary_sheet_still_renders_at_the_requested_scale(monkeypatch) -> None:
    """An A4 at scale 2 is under the bound, so its render is unchanged."""
    document = _RenderDocument((595.0, 842.0))
    _install(monkeypatch, document)

    adapter._render_first_pdf_page("ignored.pdf", scale=2)

    assert document.record["scale"] == 2
