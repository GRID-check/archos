"""The answer suite's before/after report (``scripts/turn_census/compare.py``) and the arms run, offline.

What is pinned: which checks count as accuracy, the per-answer arithmetic, how two runs pair arm by arm,
the cost read off the recorded usage, and that ``--arm all`` runs each arm with its own restriction,
directory and conversation ids, then writes the arms table and, with a baseline, the comparison.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import compare  # noqa: E402
import suite  # noqa: E402


def _run(question_id: str, **fields) -> dict:
    return suite.asdict(suite.Run(question_id=question_id, run=fields.pop("run", 1), **fields))


def _results(path: Path, runs: list[dict], **meta) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    body = {"meta": {"commit": "abc", "started": "2026-10-27 10:00", "runs_per_question": 1, **meta}, "runs": runs}
    (path / "results.json").write_text(json.dumps(body), encoding="utf-8")
    return path / "results.json"


class TestAccuracy:
    def test_only_answer_checks_count_and_process_checks_do_not(self):
        run = _run("a", checks={"must:list_files": False, "rounds<=2": False, "envelope": False, "mentions:6": True})
        assert compare.correct(run) is True
        run["checks"]["not:Sprinkler"] = False
        assert compare.correct(run) is False

    def test_a_run_with_only_process_checks_or_an_error_is_not_graded(self):
        assert compare.correct(_run("a", checks={"any:list_files": True})) is None
        assert compare.correct(_run("a", error="timed out", checks={"mentions:x": True})) is None

    def test_the_kind_of_a_check_is_its_key_before_the_colon(self):
        assert compare.check_kind("mentions:Index B") == "mentions"
        assert compare.check_kind("rounds<=3") == "rounds"
        assert compare.check_kind("judge:none_found") == "judge"


class TestTotals:
    RUNS = [
        _run("a", checks={"mentions:x": True, "must:grep": False}, research_calls=2, tool_calls=["a", "b"],
             input_tokens=1000, output_tokens=100, cost_usd=0.01, wall_s=10.0),
        _run("a", run=2, checks={"mentions:x": False}, research_calls=4, tool_calls=["a"],
             input_tokens=3000, output_tokens=300, cost_usd=0.03, wall_s=30.0),
        _run("b", checks={"any:list_files": True}, research_calls=3, input_tokens=2000, output_tokens=200,
             cost_usd=None, wall_s=20.0),
        _run("b", run=2, error="timed out"),
    ]  # fmt: skip

    def test_per_answer_means_over_finished_runs(self):
        t = compare.totals(self.RUNS)
        assert (t["runs"], t["errors"], t["graded"]) == (4, 1, 2)
        assert t["accuracy"] == 0.5
        assert t["all_checks"] == pytest.approx(1 / 3), "the first run's answer held, its tool check did not"
        assert t["rounds"] == 3.0 and t["tool_calls"] == 1.0
        assert t["input_tokens"] == 2000.0 and t["output_tokens"] == 200.0
        assert t["wall_s"] == 20.0

    def test_cost_is_the_mean_of_the_runs_that_carry_one_and_the_rest_are_counted(self):
        t = compare.totals(self.RUNS)
        assert t["cost_usd"] == pytest.approx(0.02)
        assert t["cost_missing"] == 1
        assert "1 calls uncosted" in compare.line("x", t)

    def test_nothing_finished_reads_as_dashes_not_zeroes(self):
        t = compare.totals([_run("a", error="boom")])
        assert t["accuracy"] is None and t["cost_usd"] is None and t["wall_s"] is None
        assert "| x | 1 | 1 | – | – |" in compare.line("x", t)

    def test_the_delta_is_after_minus_before_with_accuracy_in_points(self):
        before = compare.totals(self.RUNS[:2])
        after = compare.totals([self.RUNS[0]])
        d = compare.delta(before, after)
        assert d["accuracy"] == pytest.approx(0.5)
        assert d["input_tokens"] == pytest.approx(-1000)
        assert d["cost_usd"] == pytest.approx(-0.01)
        assert d["rounds"] == pytest.approx(-1)
        text = compare.delta_line("semantic", before, after)
        assert "+50 pp" in text and "-1,000" in text and "-0.0100 $" in text


class TestCost:
    def test_the_turn_cost_sums_every_billed_call_and_counts_the_uncosted(self):
        rows = [
            {"usage": {"input_tokens": 10, "cost": 0.002}},
            {"usage": {"input_tokens": 10, "cost": 0.0005}},
            {"usage": {"input_tokens": 10}},
            {"req": {"input": "ping"}},
        ]
        assert suite.turn_cost(rows) == (0.0025, 1)

    def test_observe_records_the_cost(self, tmp_path):
        url = "https://openrouter.ai/api/v1/responses"
        message = {"type": "message", "content": [{"text": "Antwort"}]}
        rows = [
            {"url": url, "t_start": 0.0, "t_end": 2.0, "req": {"input": [{"role": "user"}]},
             "usage": {"input_tokens": 100, "output_tokens": 5, "cost": 0.004}, "resp": {"output": [message]}},
        ]  # fmt: skip
        record = tmp_path / "turn.jsonl"
        record.write_text("\n".join(json.dumps(row) for row in rows))
        (tmp_path / "turn.log").write_text("")
        run = suite.observe({"id": "q", "question": "?"}, 1, record, tmp_path / "turn.log")
        assert run.cost_usd == 0.004 and run.cost_missing == 0

    def test_a_results_json_from_before_the_capture_still_loads(self):
        old = _run("a")
        del old["cost_usd"], old["cost_missing"]
        assert suite.Run(**old).cost_usd is None


class TestLoadingAndPairing:
    def test_an_arms_directory_loads_in_arm_order_and_old_arm_names_are_read_as_new(self, tmp_path):
        _results(tmp_path / "hybrid", [_run("a")], arm="hybrid")
        _results(tmp_path / "semantic", [_run("a")], arm="search")
        _results(tmp_path / "grep", [_run("a")], arm="grep")
        assert [m.label for m in compare.load(tmp_path)] == ["semantic", "grep", "hybrid"]

    def test_a_file_and_a_directory_with_one_results_json_load_alike(self, tmp_path):
        path = _results(tmp_path / "x", [_run("a")], set="loop")
        assert compare.load(path)[0].label == compare.load(path.parent)[0].label == "loop"
        (tmp_path / "empty").mkdir()
        with pytest.raises(FileNotFoundError, match="no results.json"):
            compare.load(tmp_path / "empty")

    def test_two_single_runs_pair_whatever_their_arms_and_arm_sets_pair_by_arm(self, tmp_path):
        a = compare.load(_results(tmp_path / "a", [_run("q")], arm="semantic"))
        b = compare.load(_results(tmp_path / "b", [_run("q")], arm="grep"))
        assert [(x.label, y.label) for x, y in compare.pairs(a, b)] == [("semantic", "grep")]
        for arm in ("semantic", "hybrid"):
            _results(tmp_path / "before" / arm, [_run("q")], arm=arm)
        for arm in ("grep", "hybrid"):
            _results(tmp_path / "after" / arm, [_run("q")], arm=arm)
        matched = compare.pairs(compare.load(tmp_path / "before"), compare.load(tmp_path / "after"))
        assert [(x.label, y.label) for x, y in matched] == [("hybrid", "hybrid")]


class TestReports:
    def _arms(self, root: Path, accuracy: dict[str, bool], tokens: int) -> Path:
        for arm, held in accuracy.items():
            runs = [
                _run("pf-a", checks={"mentions:x": held}, research_calls=2, input_tokens=tokens, cost_usd=0.01),
                _run("pf-b", checks={"mentions:y": True}, research_calls=3, input_tokens=tokens, cost_usd=0.02),
            ]
            _results(root / arm, runs, arm=arm)
        return root

    def test_the_arms_report_has_a_line_per_arm_and_a_row_matrix(self, tmp_path):
        root = self._arms(tmp_path / "run", {"semantic": False, "grep": True, "hybrid": True}, 1000)
        text = compare.arms_report(compare.load(root))
        assert "| semantic | 2 | 0 | 50% (n=2) |" in text
        assert "| hybrid | 2 | 0 | 100% (n=2) |" in text
        assert "| Row | semantic | grep | hybrid |" in text
        assert "| pf-a | 0/1 · 2.0 r · 1,000 tok | 1/1 · 2.0 r · 1,000 tok | 1/1 · 2.0 r · 1,000 tok |" in text

    def test_the_compare_report_prints_both_sides_the_delta_and_the_rows_that_moved(self, tmp_path):
        before = self._arms(tmp_path / "before", {"semantic": False, "hybrid": True}, 2000)
        after = self._arms(tmp_path / "after", {"semantic": True, "hybrid": True}, 1500)
        text = compare.compare_report(compare.load(before), compare.load(after))
        assert "| semantic before | 2 | 0 | 50% (n=2) |" in text
        assert "| semantic after | 2 | 0 | 100% (n=2) |" in text
        assert "| **Δ semantic** | +0 | +0 | +50 pp |" in text
        assert "| **Δ hybrid** | +0 | +0 | +0 pp |" in text and "-500" in text
        assert "## Rows that moved: semantic" in text and "`pf-a`: 0/1" in text
        assert "## Rows that moved: hybrid\n\nNone." in text

    def test_compare_writes_its_report_beside_the_after_run(self, tmp_path, capsys):
        before = self._arms(tmp_path / "before", {"hybrid": True}, 2000)
        after = self._arms(tmp_path / "after", {"hybrid": True}, 1000)
        assert suite.main(["--compare", str(before), str(after)]) == 0
        assert "Δ hybrid" in (after / "compare.md").read_text(encoding="utf-8")
        assert "Written:" in capsys.readouterr().out

    def test_compare_of_runs_that_share_no_arm_exits_2(self, tmp_path):
        before = self._arms(tmp_path / "before", {"semantic": True, "grep": True}, 1)
        after = self._arms(tmp_path / "after", {"hybrid": True, "x": True}, 1)
        assert suite.main(["--compare", str(before), str(after)]) == 2


class TestTheArmsRun:
    def test_arm_all_runs_each_arm_restricted_into_its_own_directory_then_compares(self, tmp_path, monkeypatch):
        import fixture_files

        seen: list[tuple[str, str, list]] = []

        def fake_run_set(questions, args, stamp, meta):
            seen.append((args.arm, stamp, args.override))
            assert args.out == tmp_path / "after" / args.arm
            return [suite.Run(question_id="pf-orient-project", run=1, checks={"mentions:x": True}, cost_usd=0.01)]

        monkeypatch.setattr(suite, "_preflight", lambda *a, **k: 0)
        monkeypatch.setattr(fixture_files, "seed_problem", lambda: None)
        monkeypatch.setattr(suite, "run_set", fake_run_set)
        monkeypatch.setattr(suite, "source_commit", lambda: "abc")
        before = tmp_path / "before"
        for arm in ("semantic", "grep", "hybrid"):
            _results(before / arm, [_run("pf-orient-project", checks={"mentions:x": False})], arm=arm)

        argv = ["--set", "files", "--arm", "all", "--only", "pf-orient-project", "--runs", "1"]
        code = suite.main([*argv, "--out", str(tmp_path / "after"), "--baseline", str(before)])

        assert code == 0
        assert [arm for arm, _, _ in seen] == ["semantic", "grep", "hybrid"]
        assert len({stamp for _, stamp, _ in seen}) == 3, "each arm has its own conversation ids"
        overrides = {arm: dict(pairs) for arm, _, pairs in seen}
        assert overrides["semantic"]["functions.knowledge_search.match_modes"] == "meaning"
        assert overrides["grep"]["functions.shallow_research_agent.prefetch"] == "false"
        assert overrides["hybrid"] == {}
        for arm in ("semantic", "grep", "hybrid"):
            stored = json.loads((tmp_path / "after" / arm / "results.json").read_text())
            assert stored["meta"]["arm"] == arm
        assert "| Row | semantic | grep | hybrid |" in (tmp_path / "after" / "arms.md").read_text()
        assert "+100 pp" in (tmp_path / "after" / "compare.md").read_text()

    def test_a_missing_baseline_is_refused_before_anything_runs(self, tmp_path, capsys):
        with pytest.raises(SystemExit):
            suite.main(["--set", "files", "--baseline", str(tmp_path / "nope")])
        assert "does not exist" in capsys.readouterr().err
