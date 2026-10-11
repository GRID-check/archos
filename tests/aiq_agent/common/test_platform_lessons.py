"""Tests for the platform-lessons digest resolver."""

import httpx
import pytest

from aiq_agent.common.platform_lessons import get_platform_lessons_digest
from aiq_agent.common.platform_lessons import is_in_holdout_slice
from aiq_agent.common.platform_lessons import render_lessons_block
from aiq_agent.common.platform_lessons import reset_platform_lessons_cache
from aiq_agent.common.platform_lessons import resolve_platform_lessons
from aiq_agent.common.platform_lessons import sanitize_lesson_ids
from aiq_agent.common.platform_lessons import sanitize_lessons_digest

DIGEST = 'PLATFORM_LESSONS v1\n- [wrong_source | 3x] "Vor dem Zitieren die Richtlinie prüfen."'


@pytest.fixture(autouse=True)
def _clean_cache(monkeypatch):
    reset_platform_lessons_cache()
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
    yield
    reset_platform_lessons_cache()


def _mock_bff(monkeypatch, payload: object = None, error: Exception | None = None) -> dict:
    """Patch httpx.get; returns a call counter."""
    calls = {"n": 0}

    class FakeResponse:
        def __init__(self, body: object) -> None:
            self._body = body

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return self._body

    def fake_get(url, **kwargs):
        calls["n"] += 1
        calls["url"] = url
        calls["token"] = kwargs.get("headers", {}).get("x-grid-internal-token")
        if error is not None:
            raise error
        return FakeResponse(payload)

    monkeypatch.setattr(httpx, "get", fake_get)
    return calls


class TestSanitize:
    def test_well_formed_digest_passes(self):
        assert sanitize_lessons_digest(DIGEST) == DIGEST

    def test_non_string_rejected(self):
        assert sanitize_lessons_digest(None) is None
        assert sanitize_lessons_digest(["x"]) is None
        assert sanitize_lessons_digest(42) is None

    def test_missing_header_rejected(self):
        # A payload that does not open with the versioned header is not a
        # digest this module produced — never inject arbitrary text.
        assert sanitize_lessons_digest('- [x | 1x] "no header"') is None
        assert sanitize_lessons_digest("") is None
        assert sanitize_lessons_digest("   ") is None

    def test_oversized_digest_clipped(self):
        oversized = "PLATFORM_LESSONS v1\n" + ("x" * 10_000)
        result = sanitize_lessons_digest(oversized)
        assert result is not None
        assert len(result) <= 2400


class TestResolution:
    def test_no_token_yields_none_without_fetch(self, monkeypatch):
        calls = _mock_bff(monkeypatch, {"digest": DIGEST})
        assert get_platform_lessons_digest() is None
        assert calls["n"] == 0

    def test_digest_resolves(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": DIGEST})
        assert get_platform_lessons_digest() == DIGEST

    def test_null_digest_resolves_to_none(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": None})
        assert get_platform_lessons_digest() is None

    def test_http_error_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, error=httpx.ConnectError("down"))
        assert get_platform_lessons_digest() is None

    def test_malformed_payload_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, ["not", "a", "dict"])
        assert get_platform_lessons_digest() is None

    def test_cache_avoids_repeat_fetch(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"digest": DIGEST})
        assert get_platform_lessons_digest() == DIGEST
        assert get_platform_lessons_digest() == DIGEST
        assert calls["n"] == 1

    def test_negative_result_cached(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"digest": None})
        assert get_platform_lessons_digest() is None
        assert get_platform_lessons_digest() is None
        assert calls["n"] == 1

    def test_frontend_internal_url_and_token_respected(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff:3000/")
        calls = _mock_bff(monkeypatch, {"digest": None})
        get_platform_lessons_digest()
        assert calls["url"] == "http://bff:3000/api/internal/platform-lessons/digest"
        assert calls["token"] == "tok"


class TestHoldout:
    """The control group both tiers must agree on.

    These vectors are pinned on the TypeScript side too
    (frontends/ui/src/lib/platform-lessons/holdout.spec.ts). The two
    implementations decide different things — this tier whether to INJECT, the
    BFF how to LABEL the resulting vote — so a disagreement would not fail
    anything loudly; it would quietly mislabel every measurement.
    """

    def test_off_at_zero_and_total_at_hundred(self):
        assert is_in_holdout_slice("conv-1", 0) is False
        assert is_in_holdout_slice("conv-1", 100) is True

    def test_missing_conversation_is_treated_never_control(self):
        assert is_in_holdout_slice("", 50) is False

    def test_stable_for_the_same_conversation(self):
        first = is_in_holdout_slice("conv-stable", 30)
        assert all(is_in_holdout_slice("conv-stable", 30) is first for _ in range(20))

    def test_splits_roughly_at_the_requested_percentage(self):
        ids = [f"conv-{index}" for index in range(4000)]
        share = sum(is_in_holdout_slice(cid, 10) for cid in ids) / len(ids)
        assert 0.08 < share < 0.12

    def test_monotonic_in_percentage(self):
        # Raising the holdout must not reshuffle the arms, or every measurement
        # taken before the change becomes uninterpretable.
        for index in range(500):
            cid = f"conv-{index}"
            if is_in_holdout_slice(cid, 10):
                assert is_in_holdout_slice(cid, 25) is True

    def test_agrees_with_the_typescript_twin_on_pinned_vectors(self):
        assert is_in_holdout_slice("conv-8", 10) is True
        assert is_in_holdout_slice("conv-12", 10) is True
        assert is_in_holdout_slice("conv-16", 10) is True
        assert is_in_holdout_slice("conv-0", 10) is False
        assert is_in_holdout_slice("conv-13", 10) is False


class TestHoldoutSuppression:
    def test_holdout_conversation_receives_no_digest(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"digest": DIGEST})
        monkeypatch.setattr(
            "aiq_agent.common.retrieval_settings.get_retrieval_setting",
            lambda key, fallback: 100 if key == "lessons.holdout_pct" else fallback,
        )
        assert get_platform_lessons_digest("conv-1") is None
        # And it costs nothing: a suppressed turn must not even fetch.
        assert calls["n"] == 0

    def test_treated_conversation_still_receives_the_digest(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": DIGEST})
        monkeypatch.setattr(
            "aiq_agent.common.retrieval_settings.get_retrieval_setting",
            lambda key, fallback: 0 if key == "lessons.holdout_pct" else fallback,
        )
        assert get_platform_lessons_digest("conv-1") == DIGEST

    def test_unreadable_setting_fails_open_to_treated(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": DIGEST})

        def _boom(key, fallback):
            raise RuntimeError("settings down")

        monkeypatch.setattr("aiq_agent.common.retrieval_settings.get_retrieval_setting", _boom)
        # Measurement must never decide whether a user gets an answer.
        assert get_platform_lessons_digest("conv-1") == DIGEST


class TestLessonsBlock:
    def test_renders_nothing_without_a_digest(self):
        assert render_lessons_block(None) is None
        assert render_lessons_block("   ") is None

    def test_carries_the_meta_only_framing_with_the_digest(self):
        block = render_lessons_block(DIGEST)
        assert block is not None
        assert "Meta-level only" in block
        assert "zero factual authority" in block
        assert DIGEST.strip() in block


LESSON_A = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
LESSON_B = "9b2f6c1a-7d3e-4c1b-8a55-1f0e2d3c4b5a"


def _holdout_pct(monkeypatch, value):
    def setting(key, fallback):
        if isinstance(value, Exception):
            raise value
        return value if key == "lessons.holdout_pct" else fallback

    monkeypatch.setattr("aiq_agent.common.retrieval_settings.get_retrieval_setting", setting)


class TestLessonIds:
    def test_well_formed_ids_pass_in_order_without_duplicates(self):
        assert sanitize_lesson_ids([LESSON_A, LESSON_B, LESSON_A.upper()]) == (LESSON_A, LESSON_B)

    def test_anything_that_is_not_a_uuid_list_is_dropped(self):
        assert sanitize_lesson_ids(None) == ()
        assert sanitize_lesson_ids(LESSON_A) == ()
        assert sanitize_lesson_ids([42, None, "not-an-id", f"{LESSON_A}\n<x>", LESSON_B]) == (LESSON_B,)

    def test_the_list_is_bounded(self):
        ids = [f"3f2504e0-4f89-11d3-9a0c-{index:012d}" for index in range(100)]
        assert len(sanitize_lesson_ids(ids)) == 20


class TestResolutionCarriesTheArmAndTheLessons:
    """What the trace records: the arm, and the ids of the lessons in the injected digest."""

    def test_a_treated_turn_carries_the_digest_and_its_lesson_ids(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": DIGEST, "lessonIds": [LESSON_A, LESSON_B]})
        _holdout_pct(monkeypatch, 0)
        resolution = resolve_platform_lessons("conv-0")
        assert resolution.digest == DIGEST
        assert resolution.lesson_ids == (LESSON_A, LESSON_B)
        assert resolution.arm == "off"

    def test_arm_is_treated_when_the_holdout_measures_and_the_conversation_is_outside_it(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": DIGEST, "lessonIds": [LESSON_A]})
        _holdout_pct(monkeypatch, 10)
        assert not is_in_holdout_slice("conv-0", 10)
        resolution = resolve_platform_lessons("conv-0")
        assert (resolution.arm, resolution.digest, resolution.lesson_ids) == ("treated", DIGEST, (LESSON_A,))

    def test_arm_is_holdout_with_no_digest_and_no_ids_and_no_fetch(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"digest": DIGEST, "lessonIds": [LESSON_A]})
        _holdout_pct(monkeypatch, 10)
        assert is_in_holdout_slice("conv-8", 10)
        resolution = resolve_platform_lessons("conv-8")
        assert (resolution.arm, resolution.digest, resolution.lesson_ids) == ("holdout", None, ())
        assert calls["n"] == 0

    def test_arm_is_off_without_a_conversation_to_key_on(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": DIGEST, "lessonIds": [LESSON_A]})
        _holdout_pct(monkeypatch, 100)
        resolution = resolve_platform_lessons(None)
        assert (resolution.arm, resolution.digest) == ("off", DIGEST)

    def test_an_unreadable_setting_still_injects_but_claims_no_arm(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": DIGEST, "lessonIds": [LESSON_A]})
        _holdout_pct(monkeypatch, RuntimeError("settings down"))
        resolution = resolve_platform_lessons("conv-8")
        assert (resolution.arm, resolution.digest) == ("off", DIGEST)

    def test_ids_without_a_digest_are_dropped(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": None, "lessonIds": [LESSON_A]})
        _holdout_pct(monkeypatch, 0)
        assert resolve_platform_lessons("conv-0").lesson_ids == ()

    def test_an_older_bff_without_ids_still_resolves(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": DIGEST})
        _holdout_pct(monkeypatch, 0)
        resolution = resolve_platform_lessons("conv-0")
        assert (resolution.digest, resolution.lesson_ids) == (DIGEST, ())

    def test_the_cache_keeps_the_ids_with_the_digest(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"digest": DIGEST, "lessonIds": [LESSON_A]})
        _holdout_pct(monkeypatch, 0)
        assert resolve_platform_lessons("conv-0").lesson_ids == (LESSON_A,)
        assert resolve_platform_lessons("conv-1").lesson_ids == (LESSON_A,)
        assert calls["n"] == 1
