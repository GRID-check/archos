"""The backend suite's isolation fixtures, for the evals beside it.

The evals moved out of ``tests/`` (ADR-0145 row 2), and with them out of reach of
``tests/conftest.py``. Its two autouse guards still hold here: the decision
model stays off unless a test turns it on, so a live eval measures the turn and
not a second model on the same key, and the shared cache's in-process store is
reset around every test.
"""

from tests.conftest import _isolate_shared_cache  # noqa: F401 - autouse fixture
from tests.conftest import _no_live_decisions  # noqa: F401 - autouse fixture
