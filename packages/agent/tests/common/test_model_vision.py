"""Whether the turn's model can see an image (`common/model_vision.py`).

Unknown is never "no": a catalog that cannot be read, a model it does not list
and a turn with no model bound all keep sending the image, as before the check.
"""

from __future__ import annotations

import pytest

from agent.common import model_vision


@pytest.fixture(autouse=True)
def _fresh_catalog():
    model_vision.reset_catalog_cache()
    yield
    model_vision.reset_catalog_cache()


CATALOG = {
    "data": [
        {"id": "anthropic/claude-sonnet-5", "architecture": {"input_modalities": ["text", "image"]}},
        {"id": "deepseek/deepseek-v4-pro", "architecture": {"input_modalities": ["text"]}},
        {"id": "some/unlabelled", "architecture": {}},
        {"architecture": {"input_modalities": ["text"]}},
        "not a model",
    ]
}


def test_the_catalog_is_read_as_takes_images_per_model():
    assert model_vision.parse_catalog(CATALOG) == {
        "anthropic/claude-sonnet-5": True,
        "deepseek/deepseek-v4-pro": False,
    }
    assert model_vision.parse_catalog("garbage") == {}


def test_a_variant_suffix_reads_its_base_model(monkeypatch):
    monkeypatch.setattr(model_vision, "_fetch_catalog", lambda: model_vision.parse_catalog(CATALOG))

    assert model_vision.model_accepts_images("deepseek/deepseek-v4-pro:nitro") is False
    assert model_vision.model_accepts_images("anthropic/claude-sonnet-5") is True
    assert model_vision.model_accepts_images("some/unlabelled") is None
    assert model_vision.model_accepts_images(None) is None


def test_the_catalog_is_read_once_and_a_failure_is_not_retried_on_every_image(monkeypatch):
    reads: list[int] = []

    def failing():
        reads.append(1)

    monkeypatch.setattr(model_vision, "_fetch_catalog", failing)

    assert model_vision.model_accepts_images("x/y") is None
    assert model_vision.model_accepts_images("x/y") is None
    assert reads == [1]


def test_the_bound_model_is_the_one_asked_about(monkeypatch):
    monkeypatch.setattr(model_vision, "_fetch_catalog", lambda: {"text/only": False})

    assert model_vision.turn_model_accepts_images() is None
    with model_vision.chat_model_scope("text/only"):
        assert model_vision.turn_model_accepts_images() is False
    assert model_vision.current_chat_model() is None


@pytest.mark.parametrize(
    ("llm", "expected"),
    [
        (type("Chat", (), {"model_name": "a/b"})(), "a/b"),
        (type("Chat", (), {"model": " c/d "})(), "c/d"),
        (type("Chat", (), {"model_name": None})(), None),
        (object(), None),
    ],
)
def test_the_model_name_is_read_off_a_chat_model(llm, expected):
    assert model_vision.model_name_of(llm) == expected


def test_a_freshly_booted_host_reads_the_catalog(monkeypatch):
    # A pod (or CI runner) younger than the failure back-off: its monotonic
    # clock is below five minutes. "Never failed" must not read as "failed at
    # boot", or the catalog is never read in a new pod's first minutes.
    reads: list[int] = []

    def catalog():
        reads.append(1)
        return {"text/only": False}

    monkeypatch.setattr(model_vision, "_fetch_catalog", catalog)
    monkeypatch.setattr(model_vision.time, "monotonic", lambda: 12.0)

    assert model_vision.model_accepts_images("text/only") is False
    assert reads == [1]
