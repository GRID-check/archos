# Postgres image with the Grid DB-bootstrap script baked in.
#
# Why a custom image instead of a bind mount:
# Coolify pre-creates every bind-mount *source* path as a directory before it
# runs `docker compose up`. That turns a single-file mount
# (./init-db.sql -> /docker-entrypoint-initdb.d/init-db.sql) into an empty
# directory, so psql fails with "could not read from input file: Is a
# directory" and the grid_checkpoints + grid_app databases are never created.
# Baking the script into the image removes the host bind mount entirely.
#
# Build context is deploy/ (see docker-compose.coolify.yaml), so the bootstrap
# script and the rename script `postgres-rename` runs (ADR-0145 row 10d) are both
# in reach.
FROM postgres:16-alpine
COPY compose/init-db.sql /docker-entrypoint-initdb.d/init-db.sql
COPY postgres/rename-to-grid.sh /rename-to-grid.sh
