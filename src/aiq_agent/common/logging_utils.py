"""Targeted quieting of known-noisy dependency loggers."""

import logging

# nat.builder.intermediate_step_manager assumes strictly LIFO (single-chain)
# step ordering and WARNs on every out-of-order span push/pop:
#   "Step id ... not the last step in the stack. Removing it ..."
#   "Current span ID stack is not equal to the previous stack. ..."
# These warnings had THREE causes. (1) Errored-then-retried model/tool attempts
# leaked never-closed spans because NAT's LangchainProfilerHandler implements
# no on_llm_error/on_tool_error — that one was a real defect and is FIXED
# (SpanClosingProfilerHandler in aiq_agent.common.nat_step_repair closes
# errored spans), so suppression is not papering over it. (2) LangChain runs
# every chain/LLM END on a copy of the context, so NAT's END never restored
# the span stack and the next LangGraph node STARTed under an ended parent.
# That was NOT benign: SpanExporter dropped the span and its whole subtree
# ("No parent span found", ~3,500 a week). FIXED by install_step_stack_repair
# in the same module. (3) The remainder:
# our deep-research pipeline legitimately runs steps CONCURRENTLY (parallel
# researcher workers via asyncio.gather, batched source-tool fan-out), so
# sibling steps interleave in ways NAT's single-chain model cannot represent.
# Those are benign telemetry-bookkeeping noise — the steps themselves are
# still recorded — but they flood the logs and read like errors. Raise that
# logger to ERROR until NAT supports concurrent sibling steps.
#
# nat.builder.function_info's only warning says a multi-argument tool brought
# its own input_schema, which three of ours do on purpose (bim, measure,
# read_passage), once per registration.
#
# pdfminer WARNs once per malformed font descriptor or colour operator
# ("Could not get FontBBox ...", "Cannot set stroke color ..."), about 2,000
# lines a week on ordinary architects' PDFs. It recovers and the page parses.
_NOISY_DEPENDENCY_LOGGERS = ("nat.builder.intermediate_step_manager", "nat.builder.function_info", "pdfminer")


def suppress_noisy_dependency_logs() -> None:
    """Raise known-noisy dependency loggers to ERROR.

    Idempotent; call once at process startup (API server, research worker
    and ingest worker).
    """
    for name in _NOISY_DEPENDENCY_LOGGERS:
        logging.getLogger(name).setLevel(logging.ERROR)
