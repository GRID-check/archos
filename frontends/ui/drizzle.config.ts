import { defineConfig } from "drizzle-kit";

/**
 * Migrations connect as the SCHEMA OWNER, not as the runtime role (ADR-0041).
 *
 * `APP_DATABASE_URL` now points at `app_rw`, which holds DML only and
 * is subject to row-level security — correct for serving requests, useless for
 * DDL, and actively dangerous for a data backfill, which would silently touch
 * zero rows. `APP_MIGRATION_DATABASE_URL` carries the owner credential and
 * is set only on the workload that runs migrations.
 *
 * It falls back to `APP_DATABASE_URL` so a local checkout pointed at a
 * throwaway database keeps working with one variable.
 */
const databaseUrl =
  process.env.APP_MIGRATION_DATABASE_URL ?? process.env.APP_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("APP_MIGRATION_DATABASE_URL or APP_DATABASE_URL is required");
}

export default defineConfig({
  schema: "./src/lib/db/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
