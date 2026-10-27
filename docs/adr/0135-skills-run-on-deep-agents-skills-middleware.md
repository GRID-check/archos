---
status: proposed
date: 2026-10-27
decision-makers: Grid engineering; the product owner decided the direction on 2026-10-27
consulted: the Deep Agents internal audit and external research of 2026-10-27 (deepagents 0.7.32 source)
informed: everyone working on skills, Piloti's turn and the deep researcher
---

# Skills run on Deep Agents' SkillsMiddleware, in chat and in deep research

## Context and Problem Statement

Piloti offers the office's working methods as skills in the Agent Skills
format: a `SKILL.md` with frontmatter, a one-line catalog entry per skill, and
the body read only when the model decides the task is that skill's subject.
Until this change the product ran that through two engines.

- **Chat** had its own. `SkillRuntime` rendered a catalog (`## Available
  skills`), bound a `use_skill(skill_name)` closure that returned the body, and
  could inline bodies by a size budget or the one body the turn-start decision
  chose (ADR-0063, ADR-0064).
- **Deep research had two channels at once.** Its subagents read builtin
  collections through Deep Agents' `SkillsMiddleware` over a `FilesystemBackend`
  on the worker's own `skills/builtin/` (with a subclass filtering curated
  offers out of `ls`, `read`, `glob`, `grep` and `download_files`), and its
  writer was also handed our `SkillRuntime` catalog and `use_skill` for the
  office's skills from the BFF. A skill read through the first channel was never
  recorded as activated; only `use_skill` was.

[ADR-0046](0046-agent-skills.md) chose that split. Its rejection of
`SkillsMiddleware` for chat rested on premises that can be checked, and on
2026-10-27 none of them held:

1. **"It has no request-driven forcing."** Forcing is gone from our own design:
   `skills/runtime.py` said "Nothing in this module can REQUIRE a skill", and no
   `force_skills` remains under `src/` (ADR-0060).
2. **"It offers the skill filesystem as tool content rather than a catalog the
   model opts into."** In deepagents 0.7.32, `SkillsMiddleware` lists each
   skill's name, description and `SKILL.md` path in the prompt and tells the
   model to read the body only when the task matches ("Progressive
   Disclosure", `deepagents/middleware/skills.py`). That is the catalog ADR-0046
   asked for.
3. **"One engine for both sides would distort one of them: chat needs prompt
   catalogs plus forcing."** With forcing gone, chat needs exactly what the
   middleware renders. The sandbox argument for the deep side is unaffected:
   the middleware does not care what backend serves the files.

The owner decided on 2026-10-27 that skills run on `SkillsMiddleware` for
Piloti and the deep researcher alike, that the hand-rolled chat channel and
deep research's second channel go, and that our skill logic gets much smaller.

## Decision Drivers

* One mechanism the vendor maintains, named as the Agent Skills spec names it,
  instead of a second one we write (working style: buy, don't build; industry
  standard first).
* Tenancy: an office's skills are database rows, resolved per organization;
  nothing of one tenant may be listable or readable in another tenant's run.
* Traceability: "Skills used" must keep naming exactly the bodies that reached
  the model, now in both agents.
* Piloti's system prompt is byte-identical across turns (prompt caching,
  `test_turn_context_message.py`), and its loop is its own LangGraph graph.
* The measured shortcut of ADR-0063/0064 (one chosen body rides the turn and
  saves a full-context round) is worth keeping.

## Considered Options

* **A: One read-only skills backend per run, Deep Agents' `SkillsMiddleware`
  in both agents**, Piloti rendering the middleware's catalog itself.
* **B: Keep the chat engine, move only deep research's office skills onto the
  middleware.**
* **C: Rebuild Piloti on `create_agent` so it hosts `AgentMiddleware`
  directly.**
* **D: Do nothing.**

## Decision Outcome

Chosen option: **A**, because it ends both duplicate channels with one backend
and one catalog text, and it needs no change to Piloti's graph.

**One backend.** `SkillsBackend` (`src/aiq_agent/skills/backend.py`) is an
in-memory, read-only filesystem of one run's resolved skills, served as
`/<source>/<name>/SKILL.md` (frontmatter rendered from the validated model,
then the body) and mounted at `/skills/` behind a `CompositeBackend`. It
subclasses `StateBackend` and hands it a dict instead of a graph channel, so
`ls`, `read`, `glob`, `grep` and `download_files` are stock; every write verb
refuses. Resolution stays ours, because the middleware cannot do it: the BFF
payload per organization, the Dragonfly cache keyed by organization and agent,
shadowing, `grid-agents`, and curated offers only when taken up
(`skills/resolver.py`, unchanged). The sources are the gate: Piloti lists
`/skills/office/` (everything it resolved); deep research's researcher lists
its assigned builtin collections, and its writer lists `synthesis` and then
`/skills/office/`.

**Activation is the read.** The middleware's loader uses `download_files`; the
`read_file` tool uses `read`. Only `read` records an activation (and emits the
`skill.activated` step, live when the skill has a title and is not
`grid-hidden`). The `grid-cards` preferred-cards block, with the full card
shapes, is appended on that read. `skills_activated`, `skills_hidden` and the
Langfuse trace metadata (`skills_activated`, and new `skills_offered`,
`skills_pinned`) come from the run's `SkillRuntime` as before. Deep research now
reports the builtin writer and researcher skills it reads, which it never did.

**Piloti renders, it does not host.** Piloti's agent is a `StateGraph` of its
own nodes over a pydantic state, not `create_agent`, so it cannot host
`AgentMiddleware`; and the middleware appends to the system message, which
Piloti keeps byte-identical. `SkillRuntime.catalog_block` therefore calls the
middleware's own `before_agent` (the loader) and `modify_request` (the
renderer) and puts the section in the turn context. The body is read with the
`read_file` Piloti already binds for its working directory: the skills backend
is a `/skills/` route on the same composite, read-only by permission, and a turn
without a conversation gets `read_file` for its skills alone. Both agents read
the same catalog text, our `SKILLS_PROMPT` in place of the stock one, whose
"Deepagents sources" and helper-script lines describe a setup we do not run.

**The pinned shortcut stays, in the middleware's shape.** The turn-start
decision's one chosen skill is pinned: its body rides the turn context as
`<skill name="…" path="…">`, the shape `pinned_skills` (deepagents 0.7.23)
uses, and it activates when the envelope names it in `skills_applied`. Deep
Agents' own `pinned_skills` is not used, because it appends a `HumanMessage`
and a `HumanMessage` is where Piloti's turn begins (`answer_pipeline.this_turn`).
The size budget (`skills_inline_max_body_chars`, `skills_inline_budget_chars`,
both 0 in the shipped config) is removed. Skill tools (0.7.22,
`metadata.include_tools`) are not used: no skill needs a tool the agent lacks.

What was deleted: the `use_skill` tool, the inline-by-budget renderer, the two
config keys, deep research's `MachineryOnlyFilesystemBackend` and its
`FilesystemBackend` mount, the writer's `skills_block` prompt slot and its
`use_skill` wiring through the tool set and sanitizer. The skill Python (the
`skills` package plus `deepagents_runtime.py`) went from 2,033 to 1,935 lines,
with the new backend counted; `src/` as a whole lost 213 lines net.

### Consequences

* Good, because there is one skills mechanism, and it is the vendor's: a
  deepagents release that improves the catalog or the loader improves both
  agents, and `tests/aiq_agent/test_deepagents_contract.py` says what to fix
  when one moves what we rely on.
* Good, because deep research's two channels are one, and its reads are now
  in "Skills used".
* Good, because a tenant's skills are only ever in that run's backend: nothing
  is on disk, the backend is built per run, and another organization's paths
  read as not found (`tests/aiq_agent/skills/test_backend.py`).
* Bad, because the wire changes: a skill load is a `read_file` call on a
  `/skills/…` path, not `use_skill`. The status narration skips it
  (`turn_status.is_skill_read`), and a stored turn from before still says
  `use_skill` in its tool history.
* Bad, because the catalog grows by one line per skill (the path), and the
  model must pass a path rather than a name. A path that is no skill is
  answered the way `use_skill` answered an unknown name: a prescriptive error
  naming the paths offered this turn (all of them up to twelve, else the three
  closest by name) and telling the model to call `read_file` with one, so a
  hallucinated name costs no round to rediscover them (`SkillsBackend._miss`).
* Bad, because Piloti depends on two middleware hooks called outside an agent
  (`before_agent`, `modify_request`) and on `StateBackend._read_files`, a
  private hook. The contract test guards all three.
* Neutral: the WorkOS `skills` entitlement still gates authoring and jobs in
  the BFF, not the catalog; `skills_enabled: false` is the agent's switch.

### Confirmation

* `tests/aiq_agent/skills/test_backend.py`: read-only, the document round-trips
  through our parser and the middleware's, an office skill is visible only to
  its organization, a curated offer is absent until taken up.
* `tests/aiq_agent/skills/test_runtime.py`: the catalog is the middleware's
  rendering, only a read (or a pinned body the envelope named) activates, the
  runtime cannot require a skill.
* `tests/aiq_agent/agents/piloti/test_register_skills.py`: the flag off offers
  no catalog and no skill read; a real runtime through the register records
  what the model read.
* `tests/aiq_agent/agents/deep_researcher/test_factory.py`: the office's skills
  reach the writer alone, read-only.
* `tests/aiq_agent/test_deepagents_contract.py`: the deepagents internals named
  above still exist and behave.
* The answer suite (`task be:eval:answer-suite`) has not been run on this
  change; it is the gate for whether the path-in-catalog costs a round on the
  questions that load a skill.

## Pros and Cons of the Options

### B: Move only deep research's office skills

* Good, because chat's prompt and tool surface stay exactly as measured.
* Bad, because two engines remain, and the premise that justified the chat one
  (forcing) is gone, so it is a second engine for nothing.

### C: Rebuild Piloti on `create_agent`

* Good, because Piloti would host the middleware unchanged, `pinned_skills`
  included.
* Bad, because Piloti's graph carries the round budget, the duplicate-fetch
  guard, steering, prefetch and the answer pipeline as nodes of its own; porting
  them is a separate decision, not a skills change. The premise: as of
  2026-10-27 `agents/piloti/agent.py` builds a `StateGraph` with `prefetch`,
  `agent` and `tools` nodes over a pydantic `ResearchAgentState`. If Piloti
  moves to `create_agent`, the catalog render here becomes the middleware itself.

### D: Do nothing

* Bad, because the deep researcher keeps reporting `skills_activated` for half
  of what it reads, and two copies of the curated-offer filter stay in sync by
  hand.

## More Information

* Amends in place: [ADR-0046](0046-agent-skills.md) (its "GRID-owned engine for
  chat, deepagents for deep research" decision and the rejections above) and
  [ADR-0063](0063-short-skill-bodies-ride-the-prompt.md) (the size budget is
  gone; the decision's pick is pinned). Both are Proposed, which is why they are
  amended rather than superseded: each holds other decisions that stand.
* Numbered 0135 because 0133 and 0134 are taken on a branch not yet merged
  (`claude/friendly-franklin-uhwdlk`); `check_adrs.py --next` reads only this
  checkout.
* Subsystem doc: [`../architecture/agent-skills.md`](../architecture/agent-skills.md).
