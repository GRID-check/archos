"""Citations: the sources a turn retrieved, and every citation and quote in its answer checked against them.

Start at ``verification.verify_citations`` for the answer side and at
``extraction.extract_sources_from_tool_result`` for the tool side; ``registry.SourceRegistry``
is what connects them. Each module is named after the one concept it holds.
"""
