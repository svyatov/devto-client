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

export type Verdict = "admitted" | "rejected" | "unobserved";

/** Only the first fresh probe decides; every hit before it was answering someone else. */
export function classify(probes: Probe[]): Verdict {
  const fresh = probes.find((p) => !p.fromCache);
  if (fresh === undefined) return "unobserved";
  return fresh.status === 404 ? "rejected" : "admitted";
}

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
    const probes: Probe[] = [];
    for (const encoding of ENCODINGS) {
      const seen = await probe(path, encoding);
      probes.push(seen);
      if (!seen.fromCache) break;
    }
    const verdict = classify(probes);
    const fresh = probes.find((p) => !p.fromCache);
    if (verdict === "admitted" && fresh) result.operations[key] = { status: fresh.status };
    else if (verdict === "rejected") result.rejected.push(key);
    else result.unobserved.push(key);
    console.log(`${verdict}: ${key} (${probes.map((p) => p.status).join(", ")})`);
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outFile = process.argv[2] ?? OBSERVATION_FILE;
  if (resolveTarget(process.env).apiKey === undefined) {
    throw new Error(
      "the walk must run authenticated: an anonymous 404 says nothing about what a credentialed request gets",
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
