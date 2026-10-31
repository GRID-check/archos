# =============================================================================
# The geometry service (ADR-0149): element boxes, proximity, rooms, clashes and
# box diffs over IFC models, behind the BFF's geometry route.
# =============================================================================
#
#   docker build -f apps/geometry/Dockerfile --target release -t geometry .
#
# Built from the repository root, like the backend image (apps/agent-host/Dockerfile),
# and on the same lineage: Debian 12 slim, a uv "python-build-standalone" 3.14
# carried from the builder in /opt/uv-python, the root uv.lock for every Python
# dependency, and the spatial engine (packages/ifc-spatial-py, its own lock)
# installed on its own layer. The service reuses the agent package's substrate
# (the shared cache, the BFF client, the model download and its memory admission,
# the inbound token and envelope checks), so `agent` is installed too; the
# service imports only those modules, never the agent runtime.
# =============================================================================

FROM debian:bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    tzdata \
    build-essential \
    ca-certificates \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python

RUN python3 -m pip install --break-system-packages --no-cache-dir uv \
    && uv python install 3.14 \
    && UV_PYTHON_BIN="$(uv python find 3.14)" \
    && ln -sf "$UV_PYTHON_BIN" /usr/local/bin/python \
    && ln -sf "$UV_PYTHON_BIN" /usr/local/bin/python3

RUN uv venv /app/.venv --python /usr/local/bin/python

ENV VIRTUAL_ENV=/app/.venv
ENV PATH="/app/.venv/bin:$PATH"
ENV UV_PYTHON=/app/.venv/bin/python
ENV UV_LINK_MODE=copy
ENV UV_HTTP_TIMEOUT=120 \
    UV_HTTP_RETRIES=6
ENV UV_COMPILE_BYTECODE=1

COPY pyproject.toml uv.lock ./
# Every workspace member's pyproject is read by `uv sync`, so each is present.
COPY packages/agent/ ./packages/agent/
COPY packages/knowledge-layer/ ./packages/knowledge-layer/
COPY packages/ris-adapter/ ./packages/ris-adapter/
COPY packages/tavily-web-search/ ./packages/tavily-web-search/
COPY apps/agent-host/pyproject.toml ./apps/agent-host/pyproject.toml
COPY apps/geometry/ ./apps/geometry/
COPY packages/ifc-spatial-py/ ./packages/ifc-spatial-py/

# Only the geometry member's dependency closure from the lock (`agent` and what it needs).
RUN uv sync --frozen --no-dev --no-install-workspace --package geometry

RUN uv pip install --no-deps -e ./packages/agent \
    && uv pip install --no-deps -e ./apps/geometry

# The engine, with its own dependencies (IfcOpenShell, numpy, shapely), as in the backend image.
RUN uv pip install -e ./packages/ifc-spatial-py

RUN /app/.venv/bin/python -c "import geometry_service.app; import ifc_spatial.tools; print('geometry service installed')" \
    && ! uv pip check --python /app/.venv/bin/python 2>&1 | grep "not installed"

RUN /app/.venv/bin/python -m compileall -q -j 0 /app/packages/agent /app/packages/ifc-spatial-py /app/apps/geometry

# =============================================================================
# Release
# =============================================================================
FROM debian:bookworm-slim AS release

WORKDIR /app

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/uv-python /opt/uv-python
COPY --from=builder /app /app

USER 1000:1000

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PATH="/app/.venv/bin:$PATH"
ENV APP_ENV=production

ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

EXPOSE 8100

ENTRYPOINT ["python", "-m", "geometry_service"]
