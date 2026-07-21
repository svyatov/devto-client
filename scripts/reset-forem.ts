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
import { pathToFileURL } from "node:url";
import { isLoopback } from "./record-fixtures.ts";

export const SNAPSHOT = process.env.FOREM_SNAPSHOT ?? "../forem-baseline.dump";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
export const RESET_DB = "Forem_development";

/**
 * Generous by default and overridable, because how long a restore takes is a
 * property of the machine and the snapshot. A hung `psql` waiting on a lock that
 * never clears is the case this exists for; a slow restore is not.
 */
export const RESET_TIMEOUT_MS = Number(process.env.FOREM_RESET_TIMEOUT_MS ?? 600_000);

/**
 * The HTTP half of the oracle refuses a non-loopback host; this is the same guard
 * for the half that runs `pg_dump` and `pg_restore`. A stale `DATABASE_URL`
 * pointing at another local database would otherwise be overwritten without a word.
 */
export function assertResetTarget(databaseUrl: string | undefined, expected = RESET_DB): void {
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(`DATABASE_URL is required to capture or restore the baseline (${expected})`);
  }
  const url = new URL(databaseUrl);
  if (!isLoopback(databaseUrl)) {
    throw new Error(`refusing to reset a non-loopback database host: ${url.hostname}`);
  }
  const name = url.pathname.replace(/^\//, "");
  if (name !== expected) {
    throw new Error(`refusing to capture or restore database "${name}": expected "${expected}"`);
  }
}

const run = (command: string, args: string[]): void => {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: RESET_TIMEOUT_MS });
  if (result.status !== 0) {
    const why = result.error?.message ?? `exited ${result.status ?? "on a signal"}`;
    throw new Error(`${command} ${why}`);
  }
};

// guarded like every other script here: importing this module for SNAPSHOT must
// not drop and restore a database as a side effect
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const databaseUrl = process.env.DATABASE_URL;
  // the same class of guard as the loopback refusal on the HTTP half: a stale
  // connection string would otherwise overwrite an unrelated local database
  assertResetTarget(databaseUrl);
  const url = databaseUrl as string;

  if (process.argv[2] === "capture") {
    // the snapshot is the only pristine copy of the provisioned instance, and the
    // docstring above names the one moment it is correct to take. Capturing again
    // after a sweep has run would replace the baseline with swept state silently.
    if (existsSync(SNAPSHOT) && process.env.FOREM_SNAPSHOT_FORCE === undefined) {
      throw new Error(`${SNAPSHOT} already exists: set FOREM_SNAPSHOT_FORCE=1 to replace it`);
    }
    run("pg_dump", ["-Fc", "-d", url, "-f", SNAPSHOT]);
    console.log(`baseline captured: ${SNAPSHOT}`);
  } else {
    if (!existsSync(SNAPSHOT)) {
      throw new Error(`no baseline at ${SNAPSHOT}: run \`bun run forem:reset capture\` first`);
    }
    // bare `redis-cli` talks to whatever answers on the default port, which on a
    // developer machine is rarely only this Forem. Same refusal the database half makes.
    if (!isLoopback(REDIS_URL)) {
      throw new Error(
        `refusing to flush a non-loopback redis host: ${new URL(REDIS_URL).hostname}`,
      );
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
    try {
      run("pg_restore", ["--clean", "--if-exists", "--no-owner", "-d", url, SNAPSHOT]);
    } finally {
      // the trusted-role predicate memoizes for 200 hours, so a restored database
      // with a warm cache still answers with the roles the last run left behind.
      // In a `finally` because a half-restored database with a warm cache is the
      // worst case of all: the next run's privilege verdicts would be cache artifacts.
      run("redis-cli", ["-u", REDIS_URL, "FLUSHDB"]);
    }
    console.log(`baseline restored from ${SNAPSHOT}, cache flushed`);
  }
}
