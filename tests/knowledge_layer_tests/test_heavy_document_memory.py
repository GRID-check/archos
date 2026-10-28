"""The bounded raster decode of a heavy plan set, against the real pypdfium2.

:mod:`tests.knowledge_layer_tests.test_image_extraction_memory` pins the bounded
decode through test doubles — a scripted document, page, image object and bitmap.
This module pins the same properties through the real library and the production
entry point, ``_embedded_images_for_analysis``, on a real plan set built by
``pdf_fixtures.write_plan_set``: the document shape that OOM-killed the ingest
pods (exit 137) in the visual-analysis phase.

A plan set is a sheet per drawing, each sheet carrying more than one
full-resolution raster (the scan plus a detail raster). The extractor used to
walk one page at a time, decode every raster of that page at full resolution and
hold all of them until the page's last JPEG was built, so one plan set cost
hundreds of MiB before a caption was ever asked for.

Three properties, each on a real decode:

- the per-document cap and the icon filter are settled on metadata
  (``PdfImage.get_px_size()``), so a raster that will not be analysed is never
  decoded at all;
- the size a raster was capped on is the size its decoded bitmap has, which is
  what makes a metadata-first cap safe;
- a full-resolution bitmap is open for one raster at a time, and the extractor
  never holds two full-resolution rasters' pixels at once.

Model-free and network-free: only extraction and JPEG encoding run, never a VLM
call.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from knowledge_layer_testing import pdf_fixtures

#: Small-but-kept rasters on the over-cap fixture, one below the icon filter too.
_OVER_CAP_PAGES = 8

#: The large raster the over-cap fixture is built at, above the small ones.
_OVER_CAP_RASTER_PX = (800, 600)

#: Pixels a raster costs at three bytes each, the size of every buffer this counts.
_BYTES_PER_PIXEL = 3


@dataclass
class _Decode:
    """One real decode: the size the metadata claimed, and the bitmap's own size."""

    metadata: tuple[int, int]
    bitmap: tuple[int, int]


class _Tally:
    """What one extraction run did, seen from the library and from the adapter's own seams.

    ``bitmaps`` is the constraint the incident violated: how many full-resolution
    bitmaps are open at once, and how many bytes of full-resolution pixels the
    extraction is holding — an open bitmap, plus any image the adapter detached
    at full size before downscaling it. Under the bounded decode both peak at one
    raster and do not grow with the document.
    """

    def __init__(self) -> None:
        self.decodes: list[_Decode] = []
        self.bitmaps_alive = 0
        self.peak_bitmaps_alive = 0
        self.held_bytes = 0
        self.peak_held_bytes = 0
        self._open_bitmap_bytes: dict[int, int] = {}
        self._detached_bytes: list[int] = []

    @property
    def sizes(self) -> list[tuple[int, int]]:
        """The metadata size of every decode, in the order they happened."""
        return [decode.metadata for decode in self.decodes]

    def bitmap_opened(self, bitmap: Any) -> None:
        pixels = bitmap.width * bitmap.height * _BYTES_PER_PIXEL
        self._open_bitmap_bytes[id(bitmap)] = pixels
        self.bitmaps_alive += 1
        self.peak_bitmaps_alive = max(self.peak_bitmaps_alive, self.bitmaps_alive)
        self._hold(pixels)

    def bitmap_closed(self, bitmap: Any) -> None:
        self.bitmaps_alive -= 1
        self._release(self._open_bitmap_bytes.pop(id(bitmap), 0))

    def raster_detached(self, pixels: int) -> None:
        """A bitmap copied into a PIL image the extractor keeps: pixels that outlive the bitmap."""
        self._detached_bytes.append(pixels)
        self._hold(pixels)

    def raster_consumed(self) -> None:
        if self._detached_bytes:
            self._release(self._detached_bytes.pop(0))

    def _hold(self, pixels: int) -> None:
        self.held_bytes += pixels
        self.peak_held_bytes = max(self.peak_held_bytes, self.held_bytes)

    def _release(self, pixels: int) -> None:
        self.held_bytes -= pixels


@contextlib.contextmanager
def _counting_decodes(adapter: Any) -> Iterator[_Tally]:
    """Count one run's real decodes and what it holds, restoring every hook on the way out.

    Every counter wraps a real seam: the library's ``PdfImage.get_bitmap`` and
    ``PdfBitmap.close``, and the adapter's own ``detached_pil`` (a bitmap copied
    into an image that owns its pixels) and ``_raster_record`` (where such an
    image is consumed into the JPEG that replaces it).
    """
    pdfium = pytest.importorskip("pypdfium2")
    tally = _Tally()
    real_get_bitmap = pdfium.PdfImage.get_bitmap
    real_close = pdfium.PdfBitmap.close
    real_detached_pil = adapter.detached_pil
    real_raster_record = adapter._raster_record

    def get_bitmap(self: Any, *args: Any, **kwargs: Any) -> Any:
        # ``get_px_size`` is metadata only; recording it here is what lets a test
        # assert which rasters were reached without decoding them itself.
        metadata = tuple(self.get_px_size())
        bitmap = real_get_bitmap(self, *args, **kwargs)
        tally.decodes.append(_Decode(metadata=metadata, bitmap=(bitmap.width, bitmap.height)))
        tally.bitmap_opened(bitmap)
        return bitmap

    def close(self: Any) -> Any:
        tally.bitmap_closed(self)
        return real_close(self)

    def detached_pil(bitmap: Any) -> Any:
        pixels = getattr(bitmap, "width", 0) * getattr(bitmap, "height", 0) * _BYTES_PER_PIXEL
        image = real_detached_pil(bitmap)
        tally.raster_detached(pixels)
        return image

    def raster_record(*args: Any, **kwargs: Any) -> Any:
        tally.raster_consumed()
        return real_raster_record(*args, **kwargs)

    pdfium.PdfImage.get_bitmap = get_bitmap
    pdfium.PdfBitmap.close = close
    adapter.detached_pil = detached_pil
    adapter._raster_record = raster_record
    try:
        yield tally
    finally:
        pdfium.PdfImage.get_bitmap = real_get_bitmap
        pdfium.PdfBitmap.close = real_close
        adapter.detached_pil = real_detached_pil
        adapter._raster_record = real_raster_record


@pytest.fixture(scope="module")
def adapter() -> Any:
    return pytest.importorskip("knowledge_layer.llamaindex.adapter")


@pytest.fixture(scope="module")
def heavy_plan_set(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The incident's profile: sheets of full-resolution rasters, plus three text pages."""
    path = tmp_path_factory.mktemp("heavy-plan-set") / "plan-set.pdf"
    return pdf_fixtures.write_plan_set(path)


@pytest.fixture(scope="module")
def heavy_run(heavy_plan_set: Path, adapter: Any) -> tuple[list[dict[str, Any]], int, _Tally]:
    """One real analysis of the heavy plan set, with its tally kept for the readers below."""
    with _counting_decodes(adapter) as tally:
        kept, over_cap, _ = adapter._embedded_images_for_analysis(
            str(heavy_plan_set), rendered_pages=set(), enabled=True
        )
    return kept, over_cap, tally


@pytest.fixture
def over_cap_run(adapter: Any, tmp_path: Path) -> tuple[list[dict[str, Any]], int, _Tally]:
    """A plan set past the cap: ``MAX_IMAGES_PER_DOCUMENT`` large rasters, plus droppable ones."""
    path = pdf_fixtures.write_plan_set(
        tmp_path / "over-cap.pdf",
        raster_pages=adapter.MAX_IMAGES_PER_DOCUMENT,
        rasters_per_page=1,
        raster_px=_OVER_CAP_RASTER_PX,
        small_raster_pages=_OVER_CAP_PAGES,
        include_undersized_raster=True,
    )
    with _counting_decodes(adapter) as tally:
        kept, over_cap, _ = adapter._embedded_images_for_analysis(str(path), rendered_pages=set(), enabled=True)
    return kept, over_cap, tally


def test_the_cap_and_the_icon_filter_bite_before_any_decode(over_cap_run: Any, adapter: Any) -> None:
    """Exactly ``min(MAX_IMAGES_PER_DOCUMENT, candidates)`` decodes, and none for a dropped raster.

    The fixture holds ``MAX_IMAGES_PER_DOCUMENT`` large rasters, ``_OVER_CAP_PAGES``
    small-but-kept ones and one below the icon filter. The cap keeps the large
    ones, so the decode count must be the cap, and neither a raster the cap
    dropped nor the one the filter dropped may be decoded at all.
    """
    kept, over_cap, tally = over_cap_run
    candidates = adapter.MAX_IMAGES_PER_DOCUMENT + _OVER_CAP_PAGES

    assert len(tally.decodes) == min(adapter.MAX_IMAGES_PER_DOCUMENT, candidates)
    assert len(kept) == adapter.MAX_IMAGES_PER_DOCUMENT
    assert over_cap == _OVER_CAP_PAGES

    decoded = set(tally.sizes)
    assert decoded == {_OVER_CAP_RASTER_PX}
    assert pdf_fixtures.PLAN_SET_SMALL_RASTER_PX not in decoded, "a raster the cap dropped was decoded"
    assert pdf_fixtures.PLAN_SET_UNDERSIZED_PX not in decoded, "a raster the icon filter dropped was decoded"


def test_px_size_agrees_with_the_decoded_bitmap(heavy_run: Any) -> None:
    """The metadata-first cap is only safe if ``get_px_size`` tells the truth.

    Every raster the run decoded must report, through metadata, the same width
    and height its bitmap has — otherwise the cap would drop the wrong images
    (or keep ones it meant to drop) without ever seeing the pixels.
    """
    _, _, tally = heavy_run

    assert tally.decodes, "the fixture produced no decodes to check"
    for decode in tally.decodes:
        assert decode.metadata == decode.bitmap, f"{decode.metadata} != {decode.bitmap}"
    assert pdf_fixtures.PLAN_SET_RASTER_PX in set(tally.sizes)


def test_a_full_resolution_raster_is_never_carried_past_its_decode(heavy_run: Any) -> None:
    """One full-resolution bitmap open at a time, and no full-resolution raster held.

    The sheets carry more than one raster each, so a run that keeps a sheet's
    rasters at full size reports a peak of two rasters' pixels — the hold the
    incident showed, and the one this pins. A bitmap counts while it is open; an
    image the adapter detached at full size counts until the record consumes it.
    """
    _, _, tally = heavy_run
    one_raster_bytes = pdf_fixtures.PLAN_SET_RASTER_PX[0] * pdf_fixtures.PLAN_SET_RASTER_PX[1] * _BYTES_PER_PIXEL

    assert tally.decodes, "the fixture produced no decodes to check"
    assert tally.peak_bitmaps_alive == 1, "two full-resolution bitmaps were open at once"
    assert tally.bitmaps_alive == 0, "a full-resolution bitmap was left open"
    assert tally.peak_held_bytes <= one_raster_bytes, (
        f"the extraction held {tally.peak_held_bytes} bytes of full-resolution pixels, "
        f"more than one {one_raster_bytes}-byte raster: the peak grew with the sheet"
    )
