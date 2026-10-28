"""Test support for the knowledge layer, shared by every suite that tests it.

Importable by this name because pytest's ``pythonpath`` (root ``pyproject.toml``)
lists ``packages/knowledge-layer/testing``. A suite imports its helpers from here,
never from another suite's directory by a dotted path (``tests/test_test_imports.py``),
so moving a suite moves no import. Nothing here ships in an image.
"""
