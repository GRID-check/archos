"""The session a tool list shares: the model table, the run wrapper and the open_model and briefing tools."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from functools import partial
from typing import Any

from ifc_spatial.tools_fetch import _read_source
from ifc_spatial.tools_helpers import _lower
from ifc_spatial.tools_helpers import _short
from ifc_spatial.tools_types import ToolDef
from ifc_spatial.tools_types import ToolError

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.
from .briefing import briefing as build_briefing
from .briefing import content_hash
from .briefing import render_briefing
from .cache import SpatialCache
from .model import SpatialModel
from .model import UnknownElementError
from .model import WrongKindError


def _model_table() -> tuple[Callable[[SpatialModel], str], Callable[[Any], SpatialModel]]:

    # Models are addressed by the sha256 of their bytes, abbreviated the way a
    # git object is. A handle that IS the content means two uploads of the same
    # file are one model without anybody comparing filenames, and it means a
    # stale handle cannot silently resolve to a different building.
    #
    # Held here as well as in the cache because the cache EVICTS: a handle the
    # agent was given three turns ago must still resolve, and re-reading the
    # file to honour it is exactly what the content address is for. The cache
    # bounds what a fresh open costs; this table bounds nothing and is the
    # process's real retention — a host that serves many models from one process
    # should recycle the process, which is the only isolation this server has.
    models: dict[str, SpatialModel] = {}

    def register(model: SpatialModel) -> str:
        digest = content_hash(model)
        models[digest] = model
        return digest

    def resolve(raw: Any) -> SpatialModel:
        key = str(raw or "").strip().lower()
        if not key:
            raise ToolError("model fehlt — zuerst open_model aufrufen")
        exact = models.get(key)
        if exact is not None:
            return exact
        if len(key) >= 8:
            matches = [h for h in models if h.startswith(key)]
            if len(matches) == 1:
                return models[matches[0]]
            if len(matches) > 1:
                raise ToolError(f'model "{key}" ist mehrdeutig ({len(matches)} Treffer) — mehr Stellen angeben')
        offen = ", ".join(_short(h) for h in models) or "keines"
        raise ToolError(f'model "{key}" ist nicht geöffnet — open_model aufrufen. Offen: {offen}')

    return register, resolve


def run(fn: Callable[[], Any]) -> Any:
    """An operator that raises :class:`UnknownElementError` means the caller
    could not look, which is a different thing from having looked and found
    nothing — so it becomes a tool error, while every "the file cannot say"
    stays a successful result carrying ``decidable: false``. Collapsing the
    two would let a typo in a GlobalId read as a finding about the building.

    :class:`WrongKindError` is the same class of mistake one step further in:
    the id is real and the question does not apply to it. It is a caller
    error too — an architect cannot re-export their way out of a wall being
    asked for its clear opening width — so it also becomes a ``ToolError``
    and never a finding about the export.
    """
    try:
        return fn()
    except UnknownElementError as error:
        raise ToolError(f"{error} — GlobalId mit find_elements prüfen") from None
    except WrongKindError as error:
        raise ToolError(str(error)) from None


# ── open_model ──────────────────────────────────────────────────────────


def open_model(cache: SpatialCache, register: Callable[[SpatialModel], str], args: dict[str, Any]) -> Any:
    source = str(args.get("path") or "").strip()
    started = time.perf_counter()
    try:
        if source:
            if not os.path.isfile(source):
                raise ToolError(f'Datei nicht gefunden: "{source}"')
            model = cache.load(source)
        else:
            data = _read_source(args)
            model = cache.load_bytes(data)
    except ToolError:
        raise
    except Exception as error:  # noqa: BLE001
        # `SpatialModel` refuses unreadable files with a German reason an
        # architect can act on — truncated upload, wrong format, too large
        # for a request process. That sentence is the answer; burying it
        # under a traceback would leave the agent with "es hat nicht
        # funktioniert", which nobody can do anything with.
        raise ToolError(f"Modell konnte nicht geöffnet werden: {error}") from None
    digest = register(model)
    return {
        "model": _short(digest),
        "contentHash": digest,
        "briefing": render_briefing(model),
        "seconds": round(time.perf_counter() - started, 3),
        # The geometry pass is LAZY on this engine, and saying so here is
        # the difference between an agent that plans two cheap calls and one
        # that is surprised by five seconds in the middle of an answer.
        "geometry": {
            "pass": "gelaufen" if model.geometry_seconds > 0 else "noch nicht gelaufen",
            "note": (
                "Der Geometrie-Pass läuft beim ersten Maß automatisch (~2 s für ein Einfamilienhaus). "
                "Topologische Fragen brauchen ihn nicht."
            ),
        },
    }


def _open_model_tool(cache: SpatialCache, register: Callable[[SpatialModel], str]) -> ToolDef:
    return ToolDef(
        name="open_model",
        title="Open an IFC model",
        description=(
            "Reads an IFC file and returns a model handle plus the building briefing. ALWAYS call first. The "
            "briefing names the storeys, this file's property vocabulary and — importantly — what this file "
            "CANNOT answer. Opening the same file twice is free: the result is content-addressed and cached."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Local path to the .ifc file"},
                "url": {
                    "type": "string",
                    "description": (
                        "HTTP(S) URL, e.g. a presigned URL. Publicly reachable addresses only — "
                        "loopback, private and link-local addresses are not fetched."
                    ),
                },
                "base64": {
                    "type": "string",
                    "description": "File content, base64-encoded (sensible for small models only)",
                },
            },
        },
        handler=partial(open_model, cache, register),
    )


def _briefing_tool(resolve: Callable[[Any], SpatialModel]) -> ToolDef:
    return ToolDef(
        name="briefing",
        title="Building briefing",
        description=(
            "The briefing of an already opened model again: storeys with heights, counts, this file's "
            "property vocabulary and the blind spots. Call it before filtering on a property or storey name — "
            "a name this export never wrote returns zero hits and reads like 'the building has none'."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "model": {"type": "string"},
                "format": {
                    "type": "string",
                    "enum": ["text", "json"],
                    "default": "text",
                    "description": "text = the block for the context, json = the same facts as data",
                },
            },
            "required": ["model"],
        },
        handler=lambda args: (
            {"briefing": render_briefing(resolve(args.get("model")))}
            if _lower(args.get("format")) != "json"
            else build_briefing(resolve(args.get("model"))).to_dict()
        ),
    )
