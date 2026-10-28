"""The ``folder-cards`` flag as the Python tier reads it (ADR-0127): per organization, from the BFF, kept briefly."""

import pytest

from agent.knowledge.folder_cards import gate


@pytest.fixture(autouse=True)
def _fresh():
    gate.forget()
    yield
    gate.forget()


def test_no_organization_is_off_without_asking(monkeypatch):
    monkeypatch.setattr(gate, "_fetch", lambda organization_id: pytest.fail("asked"))

    assert gate.enabled_for(None) is False
    assert gate.check("") is False


def test_the_bff_answer_is_kept_for_the_ttl(monkeypatch):
    asked = []
    monkeypatch.setattr(gate, "_fetch", lambda organization_id: asked.append(organization_id) or True)

    assert gate.enabled_for("org_1") and gate.enabled_for("org_1")

    assert asked == ["org_1"]


def test_each_organization_has_its_own_answer(monkeypatch):
    monkeypatch.setattr(gate, "_fetch", lambda organization_id: organization_id == "org_on")

    assert gate.enabled_for("org_on") is True
    assert gate.enabled_for("org_off") is False


def test_a_failed_lookup_is_off_for_a_hook_and_raises_for_the_builder(monkeypatch):
    def down(organization_id):
        raise OSError("BFF down")

    monkeypatch.setattr(gate, "_fetch", down)

    assert gate.enabled_for("org_1") is False
    with pytest.raises(OSError):
        gate.check("org_1")


def test_a_failure_is_not_kept(monkeypatch):
    answers = iter([OSError("down"), True])

    def fetch(organization_id):
        answer = next(answers)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(gate, "_fetch", fetch)

    assert gate.enabled_for("org_1") is False
    assert gate.enabled_for("org_1") is True


def test_the_environment_switch_is_gone(monkeypatch):
    monkeypatch.setenv("FOLDER_CARDS", "on")
    monkeypatch.setattr(gate, "_fetch", lambda organization_id: False)

    assert gate.enabled_for("org_1") is False
    assert not hasattr(__import__("agent.knowledge.folder_cards", fromlist=["x"]), "enabled")
