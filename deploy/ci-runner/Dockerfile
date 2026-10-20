# syntax=docker/dockerfile:1
#
# The image the cluster's CI runners run (ADR-0119): GitHub's runner image plus
# what CI's jobs expect a runner to have and `ubuntu-latest` happens to ship.
# The setup actions (Python, uv, Node, Bun, go-task) still install their own
# pinned versions in every job, so a workflow behaves the same on either runner
# and its pins stay in one place; this image only adds what no action installs.
#
# Built and pushed by the `ci-runner-image` workflow when this directory changes;
# the scale set runs the digest named in deploy/pulumi/src/platform/ci-runners.ts.
# The versions below are held to the ones CI and production use by
# tests/test_ci_toolchain_pins.py.

FROM zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f AS gitleaks
FROM aquasec/trivy:0.61.1@sha256:91bcccab7cb503127b0d792db7c652c4e556c9ff30eeb0908b6ae1980d7727ad AS trivy

FROM ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Production's Postgres major (CloudNativePG `postgresql:17`), for the throwaway
# clusters scripts/rls-test-db.sh builds. Ubuntu 24.04 ships 16, so the PGDG
# repository it is. Only the server binaries: no cluster is created at build time.
ARG POSTGRES_MAJOR=17
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg xz-utils build-essential \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-${POSTGRES_MAJOR}" \
 && rm -rf /var/lib/apt/lists/*

# Node on the PATH before any setup step: setup-task and setup-bun install with
# `npm i -g`, relying on every GitHub runner image shipping Node.
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
RUN curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.xz

# The Qdrant scripts/qdrant-test-server.sh starts, at the path it looks in first.
ARG QDRANT_VERSION=1.19.2
ARG QDRANT_SHA256=34a788a09a4cb278b5c6d2af96d9a6db30c8c7e88ae3550455f7a4d425bb8d4b
RUN curl -fsSL -o /tmp/qdrant.tar.gz "https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/qdrant-x86_64-unknown-linux-gnu.tar.gz" \
 && echo "${QDRANT_SHA256}  /tmp/qdrant.tar.gz" | sha256sum -c - \
 && install -d "/opt/qdrant/${QDRANT_VERSION}" \
 && tar -xzf /tmp/qdrant.tar.gz -C "/opt/qdrant/${QDRANT_VERSION}" qdrant \
 && rm /tmp/qdrant.tar.gz

# The scanners CI otherwise runs with `docker run`, which a runner without a
# Docker daemon cannot: the same binaries, out of the same pinned images.
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks
COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy

# A UTF-8 locale, as GitHub's runner image sets: without one, Python and initdb
# fall back to ASCII.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# `npm i -g` as the runner user, without sudo.
ENV NPM_CONFIG_PREFIX=/home/runner/.npm-global
ENV PATH=/home/runner/.npm-global/bin:/usr/lib/postgresql/${POSTGRES_MAJOR}/bin:${PATH}
RUN install -d -o runner -g runner /home/runner/.npm-global

USER runner
