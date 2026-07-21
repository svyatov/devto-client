/**
 * Restores the local Forem to its baseline snapshot, or captures a new one (U8).
 *
 * Re-seeding is not a reset: Forem's seed is written to skip what already exists,
 * so it tops up rather than reverts. Transaction wrapping is unavailable because
 * the sweep talks to the server over HTTP and holds no transaction of its own.
 *
 * Capture the baseline *after* every provisioning step - the role grants and the
 * dedicated rung accounts are database rows, and a snapshot taken straight after
 * the seed would have every restore silently delete them.
 *
 *   bun run forem:reset capture     # write the snapshot
 *   bun run forem:reset             # restore it, and flush the cache
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { assertResetTarget } from "./sweep-local.ts";

export const SNAPSHOT = process.env.FOREM_SNAPSHOT ?? "../forem-baseline.dump";

const run = (command: string, args: string[]): void => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? "on a signal"}`);
  }
};

const databaseUrl = process.env.DATABASE_URL;
// the same class of guard as the loopback refusal on the HTTP half: a stale
// connection string would otherwise overwrite an unrelated local database
assertResetTarget(databaseUrl);
const url = databaseUrl as string;

if (process.argv[2] === "capture") {
  run("pg_dump", ["-Fc", "-d", url, "-f", SNAPSHOT]);
  console.log(`baseline captured: ${SNAPSHOT}`);
} else {
  if (!existsSync(SNAPSHOT)) {
    throw new Error(`no baseline at ${SNAPSHOT}: run \`bun run forem:reset capture\` first`);
  }
  // Drop the running server's connections first. `pg_restore --clean` drops and
  // recreates every relation, and a puma worker holding prepared statements
  // against the old ones answers the next write with a 500
  // (ActiveRecord::PreparedStatementCacheExpired) - which reads as a spec finding
  // rather than as a reset artifact, and differed between two runs of the sweep.
  run("psql", [
    "-d",
    url,
    "-c",
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
  ]);
  run("pg_restore", ["--clean", "--if-exists", "--no-owner", "-d", url, SNAPSHOT]);
  // the trusted-role predicate memoizes for 200 hours, so a restored database
  // with a warm cache still answers with the roles the last run left behind
  run("redis-cli", ["FLUSHDB"]);
  console.log(`baseline restored from ${SNAPSHOT}, cache flushed`);
}
