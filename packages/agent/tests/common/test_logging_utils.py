"""Tests for targeted dependency-logger quieting."""

import logging

from agent.common.logging_utils import suppress_noisy_dependency_logs


def test_step_manager_warnings_are_suppressed_but_errors_kept():
    lg = logging.getLogger("nat.builder.intermediate_step_manager")
    original_level = lg.level
    try:
        suppress_noisy_dependency_logs()
        assert not lg.isEnabledFor(logging.WARNING)
        assert lg.isEnabledFor(logging.ERROR)
        # Idempotent.
        suppress_noisy_dependency_logs()
        assert lg.level == logging.ERROR
    finally:
        lg.setLevel(original_level)


def test_pdfminer_and_function_info_warnings_are_suppressed():
    """pdfminer's per-font and per-colour warnings were ~2,000 lines a week from the ingest worker."""
    names = ("pdfminer.pdffont", "pdfminer.pdfinterp", "nat.builder.function_info")
    loggers = {name: logging.getLogger(name) for name in ("pdfminer", "nat.builder.function_info")}
    original = {name: lg.level for name, lg in loggers.items()}
    try:
        suppress_noisy_dependency_logs()
        for name in names:
            assert not logging.getLogger(name).isEnabledFor(logging.WARNING)
            assert logging.getLogger(name).isEnabledFor(logging.ERROR)
    finally:
        for name, level in original.items():
            loggers[name].setLevel(level)
