"""The tool surface, defined without a transport.

A port of ``packages/ifc-spatial/src/mcp/tools.ts``.

## Why this file has no MCP import

MCP is how these tools are *delivered*, not what they *are*. Keeping the
definitions transport-free means the same handlers serve an MCP server, an HTTP
route inside a host application, or a direct in-process call from a test, and
none of those three has to reimplement the argument checking. It also keeps the
SDK out of the dependency path of anyone who wants the library and not the
server — which on Python matters more than it did on Node, because ``pip
install mcp`` pulls pydantic, starlette, uvicorn and httpx behind it.

## Why one `relations` tool rather than eleven

Every topological operator has the same signature — a model, an element, a list
back — so eleven tools would be eleven copies of one schema, and a model
choosing between them is choosing a name, not a shape. What must NOT be coarse
is the meaning, so the enum documents each relation individually and the answer
says which one ran.

The operators whose *shape* differs — a briefing, a table of storey heights, a
room inventory, a drawing — get their own tools, because folding them into the
same enum would produce a return type that is a union of four things and a model
that guesses which one it got.

## The one rule that is not the TS file's

**Nothing here may run geometry behind the caller's back.** On the TS engine the
geometry pass happens once inside ``openModel`` and everything afterwards is a
lookup. On IfcOpenShell the pass costs 1.6–2.4 s for a house and the space
contact map another 6 s, and both are lazy. So ``open_model``, ``briefing``,
``find_elements`` and ``element`` stay purely topological, and the tools that do
pay — ``measure``, ``distance``, ``draw``, and the four relations that need the
contact map — say so in their own description. An agent that is told a call
costs five seconds can decide it is worth it; one that finds out afterwards
cannot.
"""

from __future__ import annotations

from typing import Any  # noqa: F401

from ifc_spatial.tools_analysis import _draw_tool  # noqa: F401
from ifc_spatial.tools_analysis import _envelope_tool  # noqa: F401
from ifc_spatial.tools_analysis import _fire_tool  # noqa: F401
from ifc_spatial.tools_analysis import _light_incidence_tool  # noqa: F401
from ifc_spatial.tools_analysis import _overhang_tool  # noqa: F401
from ifc_spatial.tools_analysis import _sun_position_tool  # noqa: F401
from ifc_spatial.tools_analysis import _view_tool  # noqa: F401
from ifc_spatial.tools_constants import ALLOW_PRIVATE_URLS_ENV  # noqa: F401
from ifc_spatial.tools_constants import GEOMETRIC_RELATIONS  # noqa: F401
from ifc_spatial.tools_constants import MEASURE_EXPENSIVE  # noqa: F401
from ifc_spatial.tools_constants import MEASURE_FN  # noqa: F401
from ifc_spatial.tools_constants import MEASURE_HEADLINE  # noqa: F401
from ifc_spatial.tools_constants import MEASURE_SUBJECT  # noqa: F401
from ifc_spatial.tools_constants import MEASURES  # noqa: F401
from ifc_spatial.tools_constants import RELATION_FN  # noqa: F401
from ifc_spatial.tools_constants import RELATIONS  # noqa: F401
from ifc_spatial.tools_fetch import _GuardedRedirectHandler  # noqa: F401
from ifc_spatial.tools_fetch import _opener  # noqa: F401
from ifc_spatial.tools_fetch import _read_source  # noqa: F401
from ifc_spatial.tools_fetch import _refuse_unroutable_destination  # noqa: F401
from ifc_spatial.tools_helpers import _jsonable  # noqa: F401
from ifc_spatial.tools_inspect import _element_profile_tool  # noqa: F401
from ifc_spatial.tools_inspect import _element_tool  # noqa: F401
from ifc_spatial.tools_inspect import _find_elements_tool  # noqa: F401
from ifc_spatial.tools_inspect import _relations_tool  # noqa: F401
from ifc_spatial.tools_inspect import _room_inventory_tool  # noqa: F401
from ifc_spatial.tools_inspect import _shopping_list_tool  # noqa: F401
from ifc_spatial.tools_locate import locate_tools
from ifc_spatial.tools_measure import _clearance_tool  # noqa: F401
from ifc_spatial.tools_measure import _distance_tool  # noqa: F401
from ifc_spatial.tools_measure import _measure_tool  # noqa: F401
from ifc_spatial.tools_measure import _storey_heights_tool  # noqa: F401
from ifc_spatial.tools_measure import _survey_tool  # noqa: F401
from ifc_spatial.tools_session import _briefing_tool  # noqa: F401
from ifc_spatial.tools_session import _model_table  # noqa: F401
from ifc_spatial.tools_session import _open_model_tool  # noqa: F401
from ifc_spatial.tools_types import ToolDef  # noqa: F401
from ifc_spatial.tools_types import ToolError  # noqa: F401

from .cache import SpatialCache  # noqa: F401
from .model import UnknownElementError  # noqa: F401
from .model import WrongKindError  # noqa: F401


def create_tools(cache: SpatialCache | None = None) -> list[ToolDef]:
    """The tool list, closed over one cache and one handle table."""
    cache = cache or SpatialCache()
    register, resolve = _model_table()

    return [
        _open_model_tool(cache, register),
        _briefing_tool(resolve),
        _find_elements_tool(resolve),
        _element_tool(resolve),
        _relations_tool(resolve),
        _measure_tool(resolve),
        _survey_tool(resolve),
        _element_profile_tool(resolve),
        _distance_tool(resolve),
        _clearance_tool(resolve),
        _fire_tool(resolve),
        _envelope_tool(resolve),
        _shopping_list_tool(resolve),
        _view_tool(resolve),
        _draw_tool(resolve),
        _overhang_tool(resolve),
        _light_incidence_tool(resolve),
        _sun_position_tool(resolve),
        _storey_heights_tool(resolve),
        _room_inventory_tool(resolve),
        *locate_tools(resolve),
    ]


def call(tools: list[ToolDef], name: str, args: dict[str, Any]) -> Any:
    """Run one tool by name and return a JSON-ready result.

    The single entry point every transport uses, so an HTTP route and the MCP
    server cannot disagree about what a tool returns.

    The two caller mistakes are converted here as well as inside ``run``, so that
    a handler which forgot to wrap its operator cannot leak a Python traceback to
    an MCP client. ``mcp_server`` hands raw arguments straight to this function
    and has no second net.
    """
    for tool in tools:
        if tool.name == name:
            try:
                return _jsonable(tool.handler(args))
            except UnknownElementError as error:
                raise ToolError(f"{error} — GlobalId mit find_elements prüfen") from None
            except WrongKindError as error:
                raise ToolError(str(error)) from None
    raise ToolError(f'Unbekanntes Werkzeug "{name}". Verfügbar: {", ".join(t.name for t in tools)}')


__all__ = [
    "GEOMETRIC_RELATIONS",
    "MEASURES",
    "RELATIONS",
    "ToolDef",
    "ToolError",
    "call",
    "create_tools",
]
