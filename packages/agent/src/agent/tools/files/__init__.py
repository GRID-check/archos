"""Write-side workspace tool: one verb that proposes and never writes.

``propose_file_change`` with an ``operation`` of ``move``, ``rename``,
``create_folder`` or ``assign``. It stores the proposal on the server
(``POST /api/internal/proposals``, ADR-0105), renders one
``file_operation_proposal`` card carrying its id, and returns text saying
nothing has changed; accepting the card asks the server to apply it in the
accepting person's session. The browser executes nothing: where the server
cannot store the proposal, the tool reports that it could not propose, and the
card it leaves behind is a read-only notice.

See ``packages/agent/src/agent/tools/AGENTS.md`` for why that is the only shape a write
from this tier may take.
"""
