"""The per-turn request harness for the chat workflow.

Everything that runs once per chat turn and is NOT the answering agent lives
here: parsing what the request states about the turn, loading its context and
document inventory, binding the per-turn registries, admitting the turn
against capacity and budget, lifting the finished graph state onto the wire
response, and streaming it. The workflow entry point
(:mod:`agent.agents.piloti.conversation_register`) composes these
units; each is a small tested function with an explicit signature, so a fix in
one can be tested without standing up a NAT workflow.

Nothing here imports ``agent_host``: the API tier hosts this workflow and depends
on it, never the other way (the ``agent-api-seam`` import-linter contract).
"""
