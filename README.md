# Piloti

**The workspace for architects.** A planning office runs its work in Piloti:
its projects, its processes and the whole organization. Piloti, the agent, is a
colleague in that office. It reads the project's documents, the office's own
files and the building model, and it takes part in the work from intake to the
last report. Every claim it makes points to a passage you can open.

Building law (the OIB-Richtlinien, Austrian laws via RIS, and the office's own
norms) is one of the things Piloti knows well. It is not the frame.

**Read [`VISION.md`](VISION.md) first.** It says what the product is, and the
other documents describe Piloti the same way.

## The three parts

| Part | Where | What it does |
|---|---|---|
| **UI and BFF** | [`frontends/ui`](frontends/ui) | Next.js 16 app: projects, files, the building model, chat, tasks. Its API routes are the backend-for-frontend: auth, the Postgres database, and the WebSocket gateway (`server.js`). |
| **Agent** | [`src/aiq_agent`](src/aiq_agent) | Python service on the NeMo Agent Toolkit and LangGraph. It answers chat turns, runs research jobs and calls the models. |
| **Knowledge layer** | [`sources/knowledge_layer`](sources/knowledge_layer) | Reads the office's documents and the legal corpus, chunks and embeds them into Qdrant, and searches them with the scope of each request. |

Each part has its own `AGENTS.md` next to the code. Read it before you change
that area.

## Quick start

You need Docker, Git LFS, [`uv`](https://docs.astral.sh/uv/), [Bun](https://bun.sh)
and Node on your `PATH`, and [go-task](https://taskfile.dev) (`task`). See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the install lines.

```bash
task setup                              # 1. backend venv, UI, web and infra dependencies
.venv/bin/pre-commit install            # 2. git hooks (separate from setup)
task verify                             # 3. the merge gate, the same tasks CI runs

cp deploy/.env.example deploy/.env      # 4. then set OPENROUTER_API_KEY and TAVILY_API_KEY in deploy/.env
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env up -d --build   # 5. start the stack
```

Open <http://localhost:3000>. The backend API is on port 8000.

The building-law corpus starts empty. Put the OIB PDFs in `data/oib` (run
`git lfs pull` first), then upload them to the running backend:

```bash
GRID_ADMIN_TOKEN=... uv run python scripts/upload_oib_corpus.py data/oib
```

Each upload queues its own ingestion. Follow it in the logs:

```bash
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env logs -f aiq-agent
```

Auth needs the `WORKOS_*` values in `deploy/.env` (see
[`docs/deployment/environment-variables.md`](docs/deployment/environment-variables.md)).
Without them, set `REQUIRE_AUTH=false` for a local run.

### Models

Piloti works with any OpenAI-compatible API: OpenRouter, a self-hosted vLLM or
Ollama server, Azure OpenAI, NVIDIA NIM. The reference config is
[`configs/config_oib_openrouter.yml`](configs/config_oib_openrouter.yml). The
live default model is set by an admin in the platform, not in the YAML.

## Where to go next

- [`docs/architecture/where-is-what.md`](docs/architecture/where-is-what.md):
  find the module that owns a concept, by the name you know it by.
- [`docs/README.md`](docs/README.md): all the documentation, grouped by the
  question you arrived with.
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md):
  how the pieces fit together.
- [`docs/adr/`](docs/adr/): why it is built this way.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): branches, commits, the merge gate.
- [`AGENTS.md`](AGENTS.md): conventions for contributors and coding agents.

## Development

`task --list` shows every task. The ones you will use most:

```bash
task verify       # the full merge gate (lint, tests, type checks)
task verify:fast  # the same, without the production builds
task fe:test      # UI tests
task be:test      # backend tests
task lint:repo    # pre-commit across the repo, the scope CI lints
```

`task db:test:rls` is a separate required check when you touch the tenant
boundary. It needs PostgreSQL server binaries, so `task verify` does not run it.
See [`docs/contributing/testing-and-verification.md`](docs/contributing/testing-and-verification.md).

---

Built on the [NVIDIA AI-Q Blueprint](https://www.nvidia.com/en-us/ai/), with
[LangGraph](https://langchain-ai.github.io/langgraph/), [Qdrant](https://qdrant.tech/)
and [WorkOS](https://workos.com/).
