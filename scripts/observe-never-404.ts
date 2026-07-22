/**
 * Walks the never-404 candidates against live dev.to and writes the observation
 * the generator intersects with the composed spec (R5, KTD1). Spec structure
 * proposes a candidate; only a response recorded here admits one.
 *
 * The walk is not a test. It costs network and rate budget, so nothing in CI
 * runs it: `bun run check:drift` regenerates the set from the committed file.
 *
 * Two rules make the evidence mean something. A probe counts only at a fresh
 * cache entry, because a hit was generated for an earlier request and cannot
 * answer what this operation does today (KTD8). And a candidate that answers 404
 * is re-requested on another `Accept-Encoding` before anything is written, since
 * that is the one vary dimension dev.to's edge does key on: a single-encoding
 * probe is what produced two false all-clears during the investigation.
 *
 * Read a demotion carefully. A candidate whose every encoding replayed from
 * cache comes back unobserved, which inside the edge's TTL means "no fresh
 * evidence", not "the claim failed". A re-run soon after a previous one can
 * shrink the set for that reason alone.
 *
 * Run: DEVTO_API_KEY=... bun scripts/observe-never-404.ts [out-file]
 * Set OBSERVED_TIER when the key is not a plain api-key one: it names the rung
 * the provenance block records, and a walk on another tier is not set drift.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DevToApiError } from "../src/errors.ts";
import { request } from "../src/http.ts";
import {
  loadSpec,
  type Never404Observation,
  never404Candidates,
  OBSERVATION_FILE,
} from "./generate-signatures.ts";
import {
  buildRecorderConfig,
  DEFAULT_BASE_URL,
  type LatestResponse,
  resolveTarget,
  takeMeta,
} from "./record-fixtures.ts";

/** Rotated until a response reports a cache miss; the CDN keys on this header. */
export const ENCODINGS = ["gzip", "br", "deflate", "identity"] as const;

export interface Probe {
  status: number;
  fromCache: boolean;
}

type Verdict = "admitted" | "rejected" | "unobserved";

export interface WalkResult {
  operations: Never404Observation["operations"];
  rejected: string[];
  unobserved: string[];
}

/**
 * Probe each candidate until one response comes from the origin, then classify.
 * The probe is injected so the walk is testable without network.
 */
export async function observe(
  probe: (path: string, encoding: string) => Promise<Probe>,
  candidates: string[],
): Promise<WalkResult> {
  const result: WalkResult = { operations: {}, rejected: [], unobserved: [] };
  for (const key of candidates) {
    const path = key.slice(key.indexOf(" ") + 1);
    const statuses: number[] = [];
    let fresh: Probe | undefined;
    try {
      for (const encoding of ENCODINGS) {
        const seen = await probe(path, encoding);
        statuses.push(seen.status);
        if (!seen.fromCache) {
          fresh = seen;
          break;
        }
      }
    } catch (err) {
      // one unreachable candidate must not discard the whole walk: a re-run
      // inside the edge's TTL reads its own warmed entries, so the evidence a
      // second attempt can gather is strictly worse than what this one holds
      console.warn(`probe failed, treating as unobserved: ${key} (${String(err)})`);
      fresh = undefined;
    }
    // only the first fresh probe decides; every hit before it answered someone else
    let verdict: Verdict;
    if (fresh === undefined) {
      verdict = "unobserved";
      result.unobserved.push(key);
    } else if (fresh.status === 404) {
      verdict = "rejected";
      result.rejected.push(key);
    } else if (fresh.status === 429 || fresh.status >= 500) {
      // the origin never reached the routing layer, so it said nothing about
      // whether this path exists. A refusal (401, 400, 422) did: it answered.
      verdict = "unobserved";
      result.unobserved.push(key);
    } else {
      verdict = "admitted";
      result.operations[key] = { status: fresh.status };
    }
    console.log(`${verdict}: ${key} (${statuses.join(", ")})`);
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outFile = process.argv[2] ?? OBSERVATION_FILE;
  const target = resolveTarget(process.env);
  if (target.apiKey === undefined) {
    throw new Error(
      "the walk must run authenticated: an anonymous 404 says nothing about what a credentialed request gets",
    );
  }
  // `devto-live` is the only instrument this file can honestly claim, and it
  // names dev.to. Walking a self-hosted Forem into the committed file would
  // stamp a provenance the walk did not have, mirroring assertRecordedTierTarget.
  if (outFile === OBSERVATION_FILE && target.baseUrl !== DEFAULT_BASE_URL) {
    throw new Error(
      `refusing to write ${OBSERVATION_FILE} from ${target.baseUrl}: its provenance claims ${DEFAULT_BASE_URL}. Pass a different out file.`,
    );
  }
  const latest: LatestResponse = { meta: undefined };
  const config = buildRecorderConfig(process.env, latest);

  const probe = async (path: string, encoding: string): Promise<Probe> => {
    try {
      await request(config, "GET", path, { headers: { "accept-encoding": encoding } });
    } catch (err) {
      if (!(err instanceof DevToApiError)) throw err;
    }
    const meta = takeMeta(latest);
    if (meta === undefined) throw new Error(`no response metadata for GET ${path}`);
    return { status: meta.status, fromCache: meta.fromCache };
  };

  const candidates = never404Candidates(loadSpec());
  console.log(`walking ${candidates.length} candidates`);
  const { operations, rejected, unobserved } = await observe(probe, candidates);

  const observation: Never404Observation = {
    provenance: {
      instrument: "devto-live",
      observedAt: new Date().toISOString().slice(0, 10),
      // the walk cannot ask dev.to what its key is worth, so the operator names
      // the rung: a later re-run on another key is a tier change, not set drift
      tier: process.env.OBSERVED_TIER ?? "api-key",
      walk: `authenticated GET of every candidate at its bare path, rotating Accept-Encoding (${ENCODINGS.join(", ")}) until a response reported a cache miss; only that fresh response was counted`,
    },
    operations: Object.fromEntries(
      Object.entries(operations).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  writeFileSync(outFile, `${JSON.stringify(observation, null, 2)}\n`);
  console.log(`admitted ${Object.keys(operations).length} of ${candidates.length} to ${outFile}`);
  if (rejected.length > 0) console.warn(`answered 404 at a fresh entry: ${rejected.join(", ")}`);
  if (unobserved.length > 0) {
    console.warn(`no fresh entry, so no evidence either way: ${unobserved.join(", ")}`);
  }
}
