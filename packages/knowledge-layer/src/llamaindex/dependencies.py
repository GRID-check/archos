"""Whether the retrieval stack (llama-index, its embedder, the Qdrant client) is usable here, and why not.

Both the ingestor and the retriever call :func:`ensure_retrieval_dependencies`
before they report themselves initialised, so "initialised" means usable.
"""


def retrieval_dependency_faults() -> list[tuple[str, BaseException]]:
    """Describe, per required module, what is actually wrong with it right now.

    ``llama_index`` is a PEP-420 namespace package: the parent import succeeds
    whenever *any* ``llama-index-*`` distribution is present, even when the
    pieces we need are absent. A partial install therefore fails deep inside a
    submodule with ``cannot import name 'core' from 'llama_index' (unknown
    location)`` rather than at the obvious place, so "is it installed?" has to
    be answered per module.

    Each probe is a literal import rather than a loop over module names: the
    three are known when this is written, so computing them bought nothing and
    made the dependency graph invisible to both readers and static analysis.
    The exception type carries the distinction the report needs —
    ``ModuleNotFoundError`` means the module is genuinely absent, any other
    import failure means it is present but cannot be loaded, which is the case
    that was misreported as "not installed" for days.
    """
    faults: list[tuple[str, BaseException]] = []

    def _probe(distribution: str, module: str, load) -> None:
        try:
            load()
        except ModuleNotFoundError as exc:
            # A ModuleNotFoundError does NOT automatically mean this
            # distribution is absent: it also fires when the module imports
            # fine but one of ITS dependencies is missing. Only a failure
            # naming this module (or a parent of it) means "not installed";
            # anything else is a present-but-unusable install, which is the
            # case that has to stay distinguishable because it is the one the
            # old message got wrong.
            missing = exc.name or ""
            if missing and (module == missing or module.startswith(f"{missing}.")):
                faults.append((f"{distribution}: not installed ({exc})", exc))
            else:
                faults.append((f"{distribution}: installed but broken (missing dependency {missing or exc!r})", exc))
        except Exception as exc:  # noqa: BLE001 - the point is to report, not to handle
            faults.append((f"{distribution}: installed but broken ({type(exc).__name__}: {exc})", exc))

    def _core() -> None:
        import llama_index.core  # noqa: F401

    def _embeddings() -> None:
        from llama_index.embeddings.nvidia import NVIDIAEmbedding  # noqa: F401

    def _vector_store() -> None:
        # A presence probe only: every read and write goes through ``..qdrant``,
        # the one package that imports the client (ADR-0115).
        __import__("qdrant_client")

    _probe("llama-index-core", "llama_index.core", _core)
    _probe("llama-index-embeddings-nvidia", "llama_index.embeddings.nvidia", _embeddings)
    _probe("qdrant-client", "qdrant_client", _vector_store)
    return faults


def retrieval_dependency_report() -> list[str]:
    """The human-readable half of :func:`retrieval_dependency_faults`."""
    return [finding for finding, _ in retrieval_dependency_faults()]


def ensure_retrieval_dependencies() -> None:
    """Fail now, with the whole picture, rather than deep in a later call.

    Both initialization paths import only the piece they need first
    (``NVIDIAEmbedding``), so a missing vector-store package used to sail
    through ``_ensure_initialized`` and surface much later inside a retrieval
    or ``_run_ingestion`` — outside the handler that produces the good
    diagnostic, and after the component had already reported itself ready.
    Probing the full set up front means "initialized" means usable.
    """
    faults = retrieval_dependency_faults()
    if not faults:
        return
    # Chained from the FIRST probe failure. Running before the try/except that
    # `retrieval_dependency_error` serves means this is now the raise most
    # operators will actually see, so it has to carry the original traceback
    # too -- a summary string alone would drop the one frame that says where
    # the import broke.
    raise RuntimeError(
        "LlamaIndex retrieval stack is unusable in this environment.\nModule status:\n  "
        + "\n  ".join(finding for finding, _ in faults)
        + "\nA module reported 'installed but broken' means the distribution is present but incomplete "
        "(commonly a missing llama-index-core under the llama_index namespace package) -- reinstalling "
        "the whole extra, not adding a package, is the fix: uv sync --extra llamaindex"
    ) from faults[0][1]


def retrieval_dependency_error(cause: BaseException) -> RuntimeError:
    """Build a truthful error for a failed LlamaIndex import.

    The previous message claimed "LlamaIndex dependencies not installed" for
    every ``ImportError``. In production the packages *were* installed and one
    of them was broken (``llama-index-core`` missing under an otherwise
    populated ``llama_index`` namespace), so the advice to reinstall them was
    wrong and the real cause -- present in the chained exception all along --
    went unread for days (issues #330, #331). A diagnostic that misdescribes the
    fault costs more than no diagnostic at all, so this one reports what is
    actually true of the running environment.
    """
    findings = retrieval_dependency_report() or ["no per-module fault found; see the chained exception"]
    return RuntimeError(
        "LlamaIndex retrieval stack is unusable in this environment.\n"
        f"Triggering import error: {type(cause).__name__}: {cause}\n"
        "Module status:\n  " + "\n  ".join(findings) + "\n"
        "A module reported 'installed but broken' means the distribution is present but incomplete "
        "(commonly a missing llama-index-core under the llama_index namespace package) -- reinstalling "
        "the whole extra, not adding a package, is the fix: uv sync --extra llamaindex"
    )
