"""Write-side workspace tool: one verb that proposes and never writes.

``propose_file_change`` with an ``operation`` of ``move``, ``rename``,
``create_folder`` or ``assign``. It stores the proposal on the server
(``POST /api/internal/proposals``, ADR-0105), renders one
``file_operation_proposal`` card carrying its id, and returns text saying
nothing has changed; accepting the card asks the server to apply it in the
accepting person's session. Where the server cannot store it, the card runs
the change from the browser, as the reader, through the routes the Files pane
uses.

See ``src/aiq_agent/tools/AGENTS.md`` for why that is the only shape a write
from this tier may take.
"""
