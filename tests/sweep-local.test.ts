import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureFileName } from "../scripts/record-fixtures.ts";
import { assertResetTarget } from "../scripts/reset-forem.ts";
import {
  assertSweepSafe,
  CAPTURE_DIR,
  CAUSES,
  type Capture,
  CREATE_SEQUENCE,
  classifyPayload,
  discover,
  extractId,
  type Finding,
  isUnavailable,
  type Ladder,
  preflight,
  type RequestOpts,
  RUNG_ACCOUNT_PREFIX,
  RUNGS,
  type Rung,
  renderReport,
  resolveRung,
  resolveRungs,
  runSweep,
  sweep,
  verifyRungs,
  withLedger,
} from "../scripts/sweep-local.ts";
import { buildTargets, type SweepTarget, specOperations } from "../scripts/sweep-targets.ts";
import { DevToApiError } from "../src/errors.ts";

const scratch = mkdtempSync(join(tmpdir(), "sweep-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("KTD6 refusals fire before any request", () => {
  it("refuses a non-loopback FOREM_BASE_URL", () => {
    expect(() => assertSweepSafe({ FOREM_BASE_URL: "https://dev.to" }, CAPTURE_DIR)).toThrow(
      /non-loopback/,
    );
  });

  it("refuses an unset FOREM_BASE_URL, which would otherwise resolve to dev.to", () => {
    expect(() => assertSweepSafe({ DEVTO_API_KEY: "real-key" }, CAPTURE_DIR)).toThrow(
      /FOREM_BASE_URL is required/,
    );
  });

  it("refuses a hostname merely containing localhost", () => {
    expect(() =>
      assertSweepSafe({ FOREM_BASE_URL: "http://localhost.example.com" }, CAPTURE_DIR),
    ).toThrow(/non-loopback/);
  });

  it("accepts real loopback forms", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(() => assertSweepSafe({ FOREM_BASE_URL: url }, CAPTURE_DIR)).not.toThrow();
    }
  });

  it("refuses an out-dir outside the capture directory", () => {
    const env = { FOREM_BASE_URL: "http://localhost:3000" };
    expect(() => assertSweepSafe(env, "tests/fixtures/recorded")).toThrow(/refusing to write/);
    // the traversal a plain prefix test would wave through, straight into the Recorded tier
    expect(() => assertSweepSafe(env, `${CAPTURE_DIR}/../../tests/fixtures/recorded`)).toThrow(
      /refusing to write/,
    );
    expect(() => assertSweepSafe(env, `${CAPTURE_DIR}/run-1`)).not.toThrow();
  });
});

describe("per-rung credentials", () => {
  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    FOREM_BASE_URL: "http://localhost:3000",
    ...over,
  });

  it("hands a configured rung a client carrying that rung's key", () => {
    const r = resolveRung("admin", env({ FOREM_KEY_ADMIN: "admin-secret" }));
    expect(isUnavailable(r)).toBe(false);
    if (!isUnavailable(r)) {
      expect(r.config.apiKey).toBe("admin-secret");
      expect(r.config.baseUrl).toBe("http://localhost:3000");
    }
  });

  it("records a cause for an unconfigured rung instead of throwing", () => {
    const r = resolveRung("super_moderator", env());
    expect(isUnavailable(r)).toBe(true);
    if (isUnavailable(r)) expect(r.cause).toContain("FOREM_KEY_SUPER_MODERATOR");
  });

  it("resolves anonymous to a client with no credential, not to an unconfigured cause", () => {
    const r = resolveRung("anonymous", env());
    expect(isUnavailable(r)).toBe(false);
    if (!isUnavailable(r)) expect(r.config.apiKey).toBeUndefined();
  });

  it("never falls back to the production host or the production key", () => {
    const polluted = env({ DEVTO_API_KEY: "production", FOREM_API_KEY: "shared" });
    for (const r of resolveRungs(polluted)) {
      if (isUnavailable(r)) continue;
      expect(r.config.baseUrl).toBe("http://localhost:3000");
      expect(r.config.apiKey).not.toBe("production");
      expect(r.config.apiKey).not.toBe("shared");
    }
    // and with no rung key set, only anonymous resolves at all
    expect(
      resolveRungs(polluted)
        .filter((r) => !isUnavailable(r))
        .map((r) => r.rung),
    ).toEqual(["anonymous"]);
  });

  it("still throws the base-url and loopback refusals, for every rung", () => {
    for (const rung of RUNGS) {
      expect(() => resolveRung(rung, { FOREM_KEY_ADMIN: "k" })).toThrow(/FOREM_BASE_URL/);
      expect(() =>
        resolveRung(rung, { FOREM_BASE_URL: "https://dev.to", FOREM_KEY_ADMIN: "k" }),
      ).toThrow(/non-loopback/);
    }
  });
});

describe("classification", () => {
  // /api/tags declares an array of objects with id/name/bg_color_hex/text_color_hex
  const tag = {
    id: 1,
    name: "javascript",
    bg_color_hex: "#000",
    text_color_hex: "#fff",
    short_summary: "a tag",
  };

  it("classifies an undeclared key as disagreed and names it", () => {
    const f = classifyPayload("/api/tags", "GET", [{ ...tag, subforem_id: 3 }]);
    expect(f.kind).toBe("disagreed");
    if (f.kind === "disagreed") expect(f.extra).toEqual(["subforem_id"]);
  });

  it("classifies a missing declared key as inconclusive with element and hit counts", () => {
    const { bg_color_hex: _dropped, ...thin } = tag;
    const f = classifyPayload("/api/tags", "GET", [thin, thin]);
    expect(f.kind).toBe("inconclusive");
    if (f.kind === "inconclusive") {
      expect(f.missing).toEqual(["bg_color_hex"]);
      expect(f.elements).toBe(2);
      expect(f.hits.bg_color_hex).toBe(0);
    }
  });

  it("classifies a fully matching payload as matched", () => {
    expect(classifyPayload("/api/tags", "GET", [tag]).kind).toBe("matched");
  });

  it("classifies an empty payload as vacuous, not matched or inconclusive", () => {
    expect(classifyPayload("/api/tags", "GET", []).kind).toBe("vacuous");
    expect(classifyPayload("/api/users/me", "GET", {}).kind).toBe("vacuous");
  });

  // AE6: /api/users/{id}/suspend declares a success with no JSON body. Before the
  // ordering fix an absent payload satisfied the vacuous check first, so all 16
  // no-body writes reported "verified nothing" while actually agreeing.
  it("classifies a no-body answer against a no-body spec as confirmed-empty, not vacuous", () => {
    expect(classifyPayload("/api/users/{id}/suspend", "PUT", undefined).kind).toBe(
      "confirmed-empty",
    );
    expect(classifyPayload("/api/users/{id}/suspend", "PUT", null).kind).toBe("confirmed-empty");
  });

  it("still classifies a body against a no-body spec as disagreed", () => {
    const f = classifyPayload("/api/users/{id}/suspend", "PUT", { id: 1 });
    expect(f.kind).toBe("disagreed");
    if (f.kind === "disagreed") expect(f.note).toBe("spec declares no success body");
  });

  it("classifies a template absent from the composed spec as blocked ahead of every other branch", () => {
    const f = classifyPayload("/api/gone", "DELETE", undefined);
    expect(f.kind).toBe("unexercised");
    if (f.kind === "unexercised") expect(f.cause).toBe("blocked");
  });
});

/**
 * Drives the real sweep loop over a stubbed request function. The opts argument
 * is forwarded rather than dropped: without it no write test could assert
 * anything about the payload the sweep actually sent.
 */
const ladderOf = (
  call: (rung: Rung, m: string, p: string, o?: RequestOpts) => Promise<unknown>,
  rungs: Rung[] = ["admin"],
): Ladder => ({
  rungs: rungs.map((rung) => ({ rung, config: {} as never })),
  call,
});

const run = (
  targets: SweepTarget[],
  rf: (m: string, p: string, o?: RequestOpts) => Promise<unknown>,
): Promise<{ findings: Finding[]; captures: string[] }> =>
  sweep(
    ladderOf((_rung, m, p, o) => rf(m, p, o)),
    targets,
    scratch,
    "ae359ff41b2a",
  );

const targeted = (template: string, path: string): SweepTarget => ({
  kind: "targeted",
  template,
  method: "GET",
  path,
});

describe("request bodies reach the driver", () => {
  const capture = async (target: SweepTarget): Promise<(RequestOpts | undefined)[]> => {
    const seen: (RequestOpts | undefined)[] = [];
    await run([target], async (_m, _p, o) => {
      seen.push(o);
      return {};
    });
    return seen;
  };

  it("forwards a target's body to the request function verbatim", async () => {
    const body = { title: "t", body_markdown: "b", published: false };
    expect(
      await capture({
        kind: "targeted",
        template: "/api/articles",
        method: "POST",
        path: "/api/articles",
        body: { article: body },
      }),
    ).toEqual([{ body: { article: body } }]);
  });

  it("omits body rather than passing undefined when the target carries none", async () => {
    const [opts] = await capture(targeted("/api/tags", "/api/tags"));
    expect(opts).toBeUndefined();
  });

  it("leaves a query-only read at exactly its previous call shape", async () => {
    const [opts] = await capture({
      kind: "targeted",
      template: "/api/comments",
      method: "GET",
      path: "/api/comments",
      query: { a_id: 7 },
    });
    expect(opts).toEqual({ query: { a_id: 7 } });
    expect(opts && "body" in opts).toBe(false);
  });
});

describe("the sweep loop", () => {
  it("classifies an authorization refusal as unexercised/refused, and keeps going", async () => {
    const calls: string[] = [];
    const { findings } = await run(
      [targeted("/api/tags", "/api/tags"), targeted("/api/instance", "/api/instance")],
      async (_m, p) => {
        calls.push(p);
        if (p === "/api/tags") throw new DevToApiError(401, { error: "unauthorized" }, "");
        return { domain: "x" };
      },
    );
    expect(calls).toEqual(["/api/tags", "/api/instance"]);
    const first = findings[0];
    expect(first?.kind).toBe("unexercised");
    if (first?.kind === "unexercised") {
      expect(first.cause).toBe("refused");
      expect(first.reason).toContain("admin");
    }
    expect(findings[1]?.kind).not.toBe("unexercised");
  });

  it("catches a plain Error from request() the same way as an API error", async () => {
    const { findings } = await run([targeted("/api/tags", "/api/tags")], async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
    });
    const f = findings[0];
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") {
      expect(f.cause).toBe("blocked");
      expect(f.reason).toContain("ECONNREFUSED");
    }
  });

  it("reports a skipped entry with its cause and reason without issuing a request", async () => {
    let called = false;
    const { findings } = await run(
      [
        {
          kind: "skipped",
          template: "/api/segments/{id}",
          method: "GET",
          cause: "blocked",
          reason: "discovery unavailable: segmentId",
        },
      ],
      async () => {
        called = true;
        return null;
      },
    );
    expect(called).toBe(false);
    const f = findings[0];
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") {
      expect(f.cause).toBe("blocked");
      expect(f.reason).toBe("discovery unavailable: segmentId");
    }
  });

  it("classifies a path that derives to a different template as unexercised, naming the derived one", async () => {
    const { findings } = await run([targeted("/api/users/{id}", "/api/users/me")], async () => ({
      id: 1,
    }));
    const f = findings[0];
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") expect(f.reason).toContain("/api/users/me");
  });

  it("writes a capture with its source stamp and email addresses scrubbed", async () => {
    const { captures } = await run([targeted("/api/users/me", "/api/users/me")], async () => ({
      id: 1,
      username: "admin",
      email: "admin@forem.local",
    }));
    const name = fixtureFileName({ template: "/api/users/me", method: "GET" });
    expect(captures).toEqual([name]);
    const written = JSON.parse(readFileSync(join(scratch, name), "utf8")) as Capture;
    expect(written.source).toBe("local-forem@ae359ff41b2a");
    expect(JSON.stringify(written.payload)).not.toContain("admin@forem.local");
    expect(JSON.stringify(written.payload)).toContain("scrubbed@example.com");
    expect(written.path).toBe("/api/users/me");
  });

  it("classifies every operation exactly once against an unreachable port", async () => {
    const targets = buildTargets({});
    const { findings } = await run(targets, async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    });
    expect(findings.length).toBe(specOperations().length);
    const keys = findings.map((f) => `${f.method} ${f.template}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(findings.every((f) => f.kind === "unexercised")).toBe(true);
    // no operation is deferred any more: the write half is targeted, and a dead
    // port blocks it on the request rather than on the table
    expect(findings.filter((f) => f.method !== "GET").length).toBe(55);
  });
});

describe("the ascending tier probe", () => {
  const ALL: Rung[] = [...RUNGS];
  /** Succeeds only at `at` and above; every lower rung is refused. */
  const gate = (at: Rung, payload: unknown = { id: 1 }) => {
    const seen: Rung[] = [];
    const call = async (rung: Rung): Promise<unknown> => {
      seen.push(rung);
      if (RUNGS.indexOf(rung) < RUNGS.indexOf(at)) {
        throw new DevToApiError(401, { error: "unauthorized" }, "");
      }
      return payload;
    };
    return { seen, call };
  };

  const probe = async (
    target: SweepTarget,
    call: (rung: Rung, m: string, p: string, o?: RequestOpts) => Promise<unknown>,
    rungs: Rung[] = ALL,
  ): Promise<Finding | undefined> =>
    (await sweep(ladderOf(call, rungs), [target], scratch, "ae359ff41b2a")).findings[0];

  const del = (template: string, path: string, fromLedger = true): SweepTarget => ({
    kind: "targeted",
    template,
    method: "DELETE",
    path,
    fromLedger,
  });

  it("stops at the lowest rung that succeeds and issues no further attempts", async () => {
    const { seen, call } = gate("anonymous", [{ name: "js" }]);
    const f = await probe(targeted("/api/tags", "/api/tags"), call);
    expect(seen).toEqual(["anonymous"]);
    expect(f?.auth).toEqual({ via: "rung", rung: "anonymous" });
  });

  it("records the highest rung when only it succeeds, having left no state below it", async () => {
    const { seen, call } = gate("admin", { id: 1, name: "b", description: "d" });
    const f = await probe(del("/api/badges/{id}", "/api/badges/9"), call);
    expect(seen).toEqual([...RUNGS]);
    expect(f?.auth).toEqual({ via: "rung", rung: "admin" });
  });

  // AE3
  it("classifies an operation refused at every rung as unexercised, not disagreed or matched", async () => {
    const f = await probe(targeted("/api/tags", "/api/tags"), async () => {
      throw new DevToApiError(403, { error: "forbidden" }, "");
    });
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") {
      expect(f.cause).toBe("refused");
      expect(f.reason).toContain("anonymous");
    }
  });

  // AE4: DELETE /api/badges/{id} is destructive and the README calls badges admin-only
  it("reports a destructive rung-gated operation succeeding below its documented rung", async () => {
    const { call } = gate("user");
    const f = await probe(del("/api/badges/{id}", "/api/badges/9"), call);
    expect(f?.auth).toEqual({ via: "rung", rung: "user" });
    expect(f?.escalation).toContain("below the documented admin");
  });

  it("raises no escalation when the operation succeeds at or above its documented rung", async () => {
    const { call } = gate("admin");
    const f = await probe(del("/api/badges/{id}", "/api/badges/9"), call);
    expect(f?.escalation).toBeUndefined();
  });

  it("treats a not-found on a ledger identifier as a refusal and keeps climbing", async () => {
    const seen: Rung[] = [];
    const f = await probe(
      {
        kind: "targeted",
        template: "/api/articles/{id}",
        method: "PUT",
        path: "/api/articles/7",
        body: { article: {} },
        fromLedger: true,
      },
      async (rung) => {
        seen.push(rung);
        // Forem scopes the lookup to the caller's own articles, so a non-owner
        // sees 404 rather than 403 - the ambiguity the ledger resolves
        if (rung !== "admin") throw new DevToApiError(404, { error: "not found" }, "");
        return { type_of: "article", id: 7 };
      },
    );
    expect(seen).toEqual([...RUNGS]);
    expect(f?.kind).not.toBe("unexercised");
  });

  it("treats a not-found on an identifier the run never created as a missing target", async () => {
    const seen: Rung[] = [];
    const f = await probe(del("/api/badges/{id}", "/api/badges/9", false), async (rung) => {
      seen.push(rung);
      throw new DevToApiError(404, { error: "not found" }, "");
    });
    expect(seen).toEqual(["anonymous"]);
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") expect(f.cause).toBe("target-not-found");
  });

  it("records the relationship rather than a rung for an authorship-gated operation, with no escalation", async () => {
    const { call } = gate("user", { type_of: "article", id: 7 });
    const f = await probe(
      {
        kind: "targeted",
        template: "/api/articles/{id}",
        method: "PUT",
        path: "/api/articles/7",
        body: { article: {} },
        fromLedger: true,
      },
      call,
    );
    expect(f?.auth).toEqual({ via: "relationship", relationship: "author", rung: "user" });
    expect(f?.escalation).toBeUndefined();
  });

  it("does not escalate past a payload rejection", async () => {
    const seen: Rung[] = [];
    const f = await probe(del("/api/badges/{id}", "/api/badges/9"), async (rung) => {
      seen.push(rung);
      throw new DevToApiError(422, { error: "title is invalid" }, "");
    });
    expect(seen).toEqual(["anonymous"]);
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") expect(f.cause).toBe("payload-rejected");
  });

  it("skips an unprovisioned rung without aborting the ladder", async () => {
    const seen: Rung[] = [];
    const ladder: Ladder = {
      rungs: [
        { rung: "anonymous", cause: "tier unavailable: anonymous" },
        { rung: "user", cause: "tier unavailable: set FOREM_KEY_USER" },
        { rung: "admin", config: {} as never },
      ],
      call: async (rung) => {
        seen.push(rung);
        return [{ name: "js" }];
      },
    };
    const f = (await sweep(ladder, [targeted("/api/tags", "/api/tags")], scratch, "sha"))
      .findings[0];
    expect(seen).toEqual(["admin"]);
    expect(f?.auth).toEqual({ via: "rung", rung: "admin" });
  });

  it("reports tier-unavailable, not refused, when no rung is provisioned at all", async () => {
    const ladder: Ladder = {
      rungs: [{ rung: "admin", cause: "tier unavailable: set FOREM_KEY_ADMIN" }],
      call: async () => {
        throw new Error("should never be called");
      },
    };
    const f = (await sweep(ladder, [targeted("/api/tags", "/api/tags")], scratch, "sha"))
      .findings[0];
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") {
      expect(f.cause).toBe("tier-unavailable");
      expect(f.reason).toContain("FOREM_KEY_ADMIN");
    }
  });
});

describe("the type-scoped grant probe", () => {
  const billboard: SweepTarget = {
    kind: "targeted",
    template: "/api/billboards/{id}",
    method: "PUT",
    path: "/api/billboards/9",
    body: { body_markdown: "x" },
    fromLedger: true,
  };
  const badge: SweepTarget = {
    kind: "targeted",
    template: "/api/badges/{id}",
    method: "PATCH",
    path: "/api/badges/9",
    body: { badge: {} },
    fromLedger: true,
  };
  const ok = async (): Promise<unknown> => ({ id: 9 });
  const refuse = async (): Promise<never> => {
    throw new DevToApiError(401, { error: "unauthorized" }, "");
  };

  /** A ladder that turns `user` away and lets `admin` through, which is the shape the probe needs. */
  const probeWith = async (
    target: SweepTarget,
    scopedGrant: Ladder["scopedGrant"],
    rungCall: (rung: Rung) => Promise<unknown> = async (rung) =>
      rung === "user" ? refuse() : { id: 9 },
  ): Promise<Finding | undefined> => {
    const base = ladderOf((rung) => rungCall(rung), ["user", "admin"]);
    const ladder: Ladder = scopedGrant ? { ...base, scopedGrant } : base;
    return (await sweep(ladder, [target], scratch, "sha")).findings[0];
  };

  it("records the grant path rather than a rung when the grant authorizes the operation", async () => {
    const f = await probeWith(billboard, { call: ok });
    expect(f?.auth).toEqual({ via: "scoped-grant", resourceType: "Billboard", rung: "user" });
  });

  // the whole point of splicing the grant into the climb: the ladder used to run to
  // completion and then replay the mutation, so every affected create landed twice
  it("issues the operation once, not once per authorization path", async () => {
    const paths: string[] = [];
    await probeWith(billboard, { call: ok }, async (rung) => {
      paths.push(`rung:${rung}`);
      return rung === "user" ? refuse() : { id: 9 };
    });
    expect(paths).toEqual(["rung:user"]);
  });

  it("keeps climbing when the grant does not authorize the operation", async () => {
    const f = await probeWith(billboard, { call: refuse });
    expect(f?.auth).toEqual({ via: "rung", rung: "admin" });
    expect(f?.grantNote).toBe("the Billboard grant did not authorize this operation");
  });

  // a replayed DELETE's 404 and a duplicate's 422 are not verdicts about the grant,
  // and the old bare catch filed both as "the grant does not authorize"
  it("calls an undecidable grant response undecidable rather than a refusal", async () => {
    const f = await probeWith(billboard, {
      call: async () => {
        throw new DevToApiError(422, { error: "duplicate" }, "");
      },
    });
    expect(f?.grantNote).toBe("the Billboard grant probe was undecidable (payload-rejected)");
  });

  // the negative control: the grant account is a plain user carrying grants, so a
  // success it shares with `user` says nothing about the grant
  it("does not probe the grant when the user rung was never refused", async () => {
    let attempts = 0;
    const f = await probeWith(
      billboard,
      {
        call: async () => {
          attempts += 1;
          return {};
        },
      },
      async () => ({ id: 9 }),
    );
    expect(attempts).toBe(0);
    expect(f?.auth).toEqual({ via: "rung", rung: "user" });
    expect(f?.grantNote).toBe(
      "the user rung never refused this operation, so the grant path was not probed",
    );
  });

  it("skips the extra attempt entirely for an operation with no scoped-grant path", async () => {
    let attempts = 0;
    const f = await probeWith(badge, {
      call: async () => {
        attempts += 1;
        return {};
      },
    });
    expect(attempts).toBe(0);
    expect(f?.auth).toEqual({ via: "rung", rung: "admin" });
    expect(f?.grantNote).toBeUndefined();
  });

  it("records a cause without discarding the ladder result when the grant is not provisioned", async () => {
    const f = await probeWith(billboard, { cause: "FOREM_KEY_SCOPED_GRANT is not set" });
    expect(f?.auth).toEqual({ via: "rung", rung: "admin" });
    expect(f?.grantNote).toBe("FOREM_KEY_SCOPED_GRANT is not set");
    expect(f?.kind).not.toBe("unexercised");
  });
});

describe("the ordered write sequence", () => {
  /**
   * A stub Forem: reads answer thinly, creates hand back an id, and everything is
   * recorded in call order so the phase assertions can read the sequence back.
   */
  const instance = (over: { fail?: string[] } = {}) => {
    const calls: string[] = [];
    let next = 100;
    const call = async (_rung: Rung, method: string, path: string): Promise<unknown> => {
      const op = `${method} ${path}`;
      calls.push(op);
      if (over.fail?.some((f) => op.startsWith(f))) {
        throw new DevToApiError(422, { error: "rejected" }, "");
      }
      if (method === "POST") return { id: next++ };
      if (method === "GET") return path.endsWith("s") ? [{ id: 1 }] : { id: 1 };
      return undefined;
    };
    return { calls, ladder: ladderOf(call, ["admin"]) };
  };

  const seeded = { articleId: 1, targetUserId: 5, mergeUserId: 6, runId: "t" };

  it("runs creates before the reads that depend on them, and destructive operations last", async () => {
    const { calls, ladder } = instance();
    await runSweep(ladder, seeded, scratch, "sha");
    const firstCreate = calls.findIndex((c) => c.startsWith("POST /api/badges"));
    const badgeRead = calls.findLastIndex((c) => /^GET \/api\/badges\/\d+$/.test(c));
    const firstDestroy = calls.findIndex((c) => c.startsWith("DELETE "));
    expect(firstCreate).toBeGreaterThan(-1);
    // the read of the created badge happens after the create that made it
    expect(badgeRead).toBeGreaterThan(firstCreate);
    // and nothing destructive runs before the last create
    const lastCreate = calls.findLastIndex((c) =>
      CREATE_SEQUENCE.some(({ op }) => c.startsWith(`${op.split(" ")[0]} ${op.split("{")[0]}`)),
    );
    expect(firstDestroy).toBeGreaterThan(lastCreate);
  });

  it("runs the role and standing mutations after every other phase", async () => {
    const { calls, ladder } = instance();
    await runSweep(ladder, seeded, scratch, "sha");
    const standing = calls.findIndex((c) => /\/(suspend|trusted|spam|limited)$/.test(c));
    const lastUpdate = calls.findLastIndex((c) => c.startsWith("PATCH ") || c.startsWith("PUT "));
    expect(standing).toBeGreaterThan(-1);
    // every non-destructive PUT/PATCH is already done by the time standing changes
    const lastSafe = calls.findLastIndex(
      (c) =>
        (c.startsWith("PATCH ") || c.startsWith("PUT ")) &&
        !/\/(suspend|trusted|spam|limited|unpublish)$/.test(c),
    );
    expect(standing).toBeGreaterThan(lastSafe);
    expect(lastUpdate).toBeGreaterThanOrEqual(standing);
  });

  it("records the creating rung alongside each identifier", async () => {
    const { ladder } = instance();
    const { ledger } = await runSweep(ladder, seeded, scratch, "sha");
    expect(ledger.badge).toEqual({ id: expect.any(Number), rung: "admin" });
    expect(Object.keys(ledger).length).toBeGreaterThan(5);
  });

  it("degrades an update and a delete to a cause naming the failed create, and keeps going", async () => {
    const { ladder } = instance({ fail: ["POST /api/badges"] });
    const { findings } = await runSweep(ladder, seeded, scratch, "sha");
    const by = (k: string): Finding | undefined =>
      findings.find((f) => `${f.method} ${f.template}` === k);
    for (const op of ["PATCH /api/badges/{id}", "DELETE /api/badges/{id}"]) {
      const f = by(op);
      expect(f?.kind).toBe("unexercised");
      if (f?.kind === "unexercised") {
        expect(f.cause).toBe("prerequisite-failed");
        expect(f.reason).toBe("not created by this run: badge");
      }
    }
    // the rest of the run is unaffected
    expect(by("GET /api/tags")?.kind).not.toBe("unexercised");
  });

  it("yields exactly one finding per operation, with the re-run's verdict replacing the blocked one", async () => {
    const { ladder } = instance();
    const { findings } = await runSweep(ladder, seeded, scratch, "sha");
    const keys = findings.map((f) => `${f.method} ${f.template}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(specOperations().length);
    // /api/pages/{id} had no discoverable pageId; the create supplied one
    const page = findings.find((f) => `${f.method} ${f.template}` === "GET /api/pages/{id}");
    expect(page?.kind).not.toBe("unexercised");
  });

  it("leaves a read whose identifier is never created blocked with its original cause", async () => {
    const { ladder } = instance({ fail: ["POST /api/segments"] });
    const { findings } = await runSweep(ladder, seeded, scratch, "sha");
    const f = findings.find((x) => `${x.method} ${x.template}` === "GET /api/segments/{id}");
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") expect(f.reason).toBe("discovery unavailable: segmentId");
  });

  it("hands the checkpoint every finding gathered before the destructive phase runs", async () => {
    const { ladder } = instance();
    let checkpointed: Finding[] = [];
    await runSweep(ladder, seeded, scratch, "sha", (f) => {
      checkpointed = f;
    });
    expect(checkpointed.length).toBeGreaterThan(100);
    // the destructive verdicts are precisely what the checkpoint does not yet have
    const deletes = checkpointed.filter((f) => f.method === "DELETE" && f.kind !== "unexercised");
    expect(deletes).toEqual([]);
  });
});

// the ledger is only as good as this: an id it fails to read leaves every
// dependent update and delete reporting prerequisite-failed, which reads as a
// gap in the server rather than as a gap in the parser
describe("reading the id a create handed back", () => {
  it.each([
    ["a flat id", { id: 5 }, 5],
    ["an id_code, which comments use instead", { id_code: "abc123" }, "abc123"],
    ["id ahead of id_code when both are present", { id: 5, id_code: "abc123" }, 5],
    ["a payload Forem wraps one level", { badge: { id: 7 } }, 7],
    ["a wrapper whose inner id is a string", { page: { id: "slug-1" } }, "slug-1"],
  ])("reads %s", (_label, payload, expected) => {
    expect(extractId(payload)).toBe(expected);
  });

  it.each([
    ["a payload with no id anywhere", { title: "x" }],
    ["a nested object carrying no id", { badge: { name: "x" } }],
    ["an array, which no create returns", [{ id: 1 }]],
    ["null", null],
    ["a bare string", "5"],
  ])("returns undefined for %s", (_label, payload) => {
    expect(extractId(payload)).toBeUndefined();
  });
});

describe("the ledger's reach into read recipes", () => {
  const badgeRead = (d: Parameters<typeof buildTargets>[0]): SweepTarget | undefined =>
    buildTargets(d).find((t) => t.template === "/api/badges/{id}" && t.method === "GET");

  // F2 used to stop at the writes: `made` marked its own targets and nothing marked
  // the reads, so a read of a record this run created reported target-not-found
  // where the honest answer was a refusal
  it("marks a read whose identifier the ledger supplied", () => {
    const filled = withLedger({}, { badge: { id: 77, rung: "admin" } });
    expect(filled.ledgerFields).toContain("badgeId");
    expect(badgeRead(filled)).toMatchObject({ path: "/api/badges/77", fromLedger: true });
  });

  it("leaves a discovered identifier unmarked, since no create proved that record exists", () => {
    const filled = withLedger({ badgeId: 3 }, { badge: { id: 77, rung: "admin" } });
    const target = badgeRead(filled);
    expect(target).toMatchObject({ path: "/api/badges/3" });
    expect(target && "fromLedger" in target ? target.fromLedger : undefined).toBeUndefined();
  });
});

describe("the reset pre-flight", () => {
  const clean = { users: 10, articles: 5, rungsUnverified: [] as Rung[] };

  it("passes on a fully provisioned instance", () => {
    expect(preflight(clean)).toEqual([]);
  });

  it("fails with a named cause when baseline discovery is below the floor", () => {
    const problems = preflight({ ...clean, users: 4 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("4 users");
  });

  it("fails when a configured rung's account did not survive the restore", () => {
    const problems = preflight({ ...clean, rungsUnverified: ["super_moderator"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("super_moderator");
  });

  it("names the reset procedure rather than the missing field", () => {
    for (const p of preflight({ users: 0, articles: 0, rungsUnverified: ["admin"] })) {
      expect(p).toContain("bun run forem:reset");
    }
  });

  // the user count is read off an admin-only listing, so with no admin key it is
  // zero whatever the database holds, and blaming the baseline sends the operator
  // to restore something that was never broken
  it("blames the missing admin key, not the database, when the count it reads is admin-only", () => {
    const problems = preflight({ ...clean, users: 0, rungsUnavailable: ["admin"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("FOREM_KEY_ADMIN");
    expect(problems[0]).not.toContain("bun run forem:reset");
  });

  it("refuses a database whose identifier is not the expected local one", () => {
    expect(() => assertResetTarget("postgres://localhost:5432/some_other_db")).toThrow(
      /refusing to capture or restore database "some_other_db"/,
    );
    expect(() => assertResetTarget("postgres://db.example.com:5432/Forem_development")).toThrow(
      /non-loopback/,
    );
    expect(() => assertResetTarget(undefined)).toThrow(/DATABASE_URL is required/);
    expect(() => assertResetTarget("postgres://localhost:5432/Forem_development")).not.toThrow();
  });

  it("reports a rung whose key answers as the wrong account", async () => {
    const ladder: Ladder = {
      rungs: [
        { rung: "anonymous", config: {} as never },
        { rung: "user", config: {} as never },
        { rung: "admin", config: {} as never },
      ],
      call: async (rung) =>
        rung === "user"
          ? { username: "someone-else" }
          : { username: `${RUNG_ACCOUNT_PREFIX}${rung}` },
    };
    expect(await verifyRungs(ladder)).toEqual(["user"]);
  });
});

describe("discovery", () => {
  const routes: Record<string, unknown> = {
    "/api/articles": [
      { id: 7, path: "/acme/org-post", organization: { username: "acme" }, user: { user_id: 1 } },
      { id: 9, path: "/alice/my-post", user: { user_id: 42 } },
    ],
    "/api/users/me": { id: 1, email: "admin@forem.local" },
    "/api/comments": [{ id_code: "abc" }],
    "/api/tags": [{ name: "javascript" }],
    "/api/pages": [{ id: 3 }],
    "/api/badges": [],
  };
  const stub = (
    over: Record<string, unknown> = {},
  ): ((m: string, p: string) => Promise<unknown>) => {
    const table = { ...routes, ...over };
    return async (_m, p) => {
      if (!(p in table)) throw new DevToApiError(404, { error: "not found" }, "");
      return table[p];
    };
  };

  it("prefers a non-org article so the derived username is a user, not an organization", async () => {
    const d = await discover(stub());
    expect(d.articleId).toBe(9);
    expect(d.username).toBe("alice");
    expect(d.slug).toBe("my-post");
    expect(d.userId).toBe(42);
    // the org still gets discovered, just not as the {username} source
    expect(d.organization).toBe("acme");
  });

  it("leaves a field unset when its index is empty or the endpoint fails, rather than guessing", async () => {
    const d = await discover(stub());
    expect(d.pageId).toBe(3);
    expect(d.badgeId).toBeUndefined(); // empty index
    expect(d.conceptId).toBeUndefined(); // 404
    expect(d.analyticsStart).toBe("2020-01-01"); // fixed window, not discovered
  });

  it("never selects a rung account or the caller as a write target (R20)", async () => {
    const d = await discover(
      stub({
        "/api/admin/users": {
          users: [
            { id: 1, username: "admin" }, // the caller, per /api/users/me
            { id: 2, username: `${RUNG_ACCOUNT_PREFIX}trusted` },
            { id: 3, username: `${RUNG_ACCOUNT_PREFIX}admin` },
            { id: 4, username: "bob" },
            { id: 5, username: "carol" },
          ],
        },
      }),
    );
    expect(d.targetUserId).toBe(4);
    expect(d.mergeUserId).toBe(5);
  });

  it("leaves both write targets unset when only rung accounts exist, rather than aiming at one", async () => {
    const d = await discover(
      stub({
        "/api/admin/users": { users: [{ id: 2, username: `${RUNG_ACCOUNT_PREFIX}user` }] },
      }),
    );
    expect(d.targetUserId).toBeUndefined();
    expect(d.mergeUserId).toBeUndefined();
  });

  it("skips a numeric organization username, which would derive to {id} and mislabel", async () => {
    const numeric = [{ id: 7, path: "/123/p", organization: { username: "123" } }];
    expect((await discover(stub({ "/api/articles": numeric }))).organization).toBeUndefined();
  });

  it("survives a Forem that answers nothing, leaving every field unset", async () => {
    const d = await discover(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
    });
    expect(d).toEqual({ analyticsStart: "2020-01-01", baseline: { users: 0, articles: 0 } });
  });
});

describe("the report", () => {
  it("names the template, method, observed keys and a disposition slot per disagreement", () => {
    const md = renderReport(
      [
        { kind: "disagreed", template: "/api/tags", method: "GET", extra: ["subforem_id"] },
        {
          kind: "inconclusive",
          template: "/api/articles",
          method: "GET",
          missing: ["organization"],
          elements: 4,
          hits: { organization: 0 },
        },
        {
          kind: "unexercised",
          template: "/api/follows",
          method: "POST",
          cause: "prerequisite-failed",
          reason: "not created by this run: article",
        },
      ],
      "ae359ff41b2a",
      "http://localhost:3000",
    );
    expect(md).toContain("ae359ff41b2a");
    expect(md).toContain("`GET /api/tags`");
    expect(md).toContain("subforem_id");
    expect(md).toContain("disposition");
    expect(md).toContain("organization 0/4");
    expect(md).toContain("`POST /api/follows`");
  });

  it("renders every section even on a run with nothing to report", () => {
    const md = renderReport([], "ae359ff41b2a", "http://localhost:3000");
    for (const heading of [
      "## Disagreed (0)",
      "## Inconclusive (0)",
      "## Matched (0)",
      "## Confirmed empty (0)",
      "## Vacuous (0)",
      "## Unexercised (0)",
      "## Escalation findings (0)",
      "## README tier reconciliation (0)",
      "## Inline unnamed response schemas (0)",
    ]) {
      expect(md).toContain(heading);
    }
    for (const cause of CAUSES) expect(md).toContain(`### ${cause} (0)`);
  });

  it("carries each write's tier, relationship or scoped-grant value, with its attestation", () => {
    const md = renderReport(
      [
        {
          kind: "confirmed-empty",
          template: "/api/badges/{id}",
          method: "DELETE",
          auth: { via: "rung", rung: "admin" },
        },
        {
          kind: "matched",
          template: "/api/articles/{id}",
          method: "PUT",
          auth: { via: "relationship", relationship: "author", rung: "user" },
        },
        {
          kind: "matched",
          template: "/api/billboards/{id}",
          method: "PUT",
          auth: { via: "scoped-grant", resourceType: "Billboard", rung: "admin" },
        },
      ],
      "ae359ff41b2a",
      "http://localhost:3000",
    );
    expect(md).toContain("`DELETE /api/badges/{id}` - admin");
    expect(md).toContain("author relationship, not a rung");
    expect(md).toContain("single_resource_admin on Billboard, not a rung");
    expect(md).toContain("No second");
    expect(md).toContain("corroborate");
  });

  it("lists a tier that disagrees with the README's table, and skips relationship-gated ones", () => {
    const md = renderReport(
      [
        // README calls badges admin-only
        {
          kind: "confirmed-empty",
          template: "/api/badges/{id}",
          method: "DELETE",
          auth: { via: "rung", rung: "user" },
          escalation: "succeeded at user, below the documented admin",
        },
        {
          kind: "matched",
          template: "/api/articles/{id}",
          method: "PUT",
          auth: { via: "relationship", relationship: "author", rung: "trusted" },
        },
      ],
      "ae359ff41b2a",
      "http://localhost:3000",
    );
    expect(md).toContain("## README tier reconciliation (1)");
    expect(md).toContain("README says admin, observed user");
    expect(md).not.toContain("`PUT /api/articles/{id}` - README says");
    expect(md).toContain("## Escalation findings (1)");
  });

  // the README calls organizations public; nothing below a grant authorized this
  // one, and dropping every grant-authorized finding from the table hid that
  it("lists a grant-authorized write against a README entry claiming a rung it refused", () => {
    const md = renderReport(
      [
        {
          kind: "matched",
          template: "/api/organizations",
          method: "POST",
          auth: { via: "scoped-grant", resourceType: "Organization", rung: "user" },
        },
        // billboards are documented admin, which the grant observation does not refute
        {
          kind: "matched",
          template: "/api/billboards",
          method: "POST",
          auth: { via: "scoped-grant", resourceType: "Billboard", rung: "user" },
        },
      ],
      "ae359ff41b2a",
      "http://localhost:3000",
    );
    expect(md).toContain("## README tier reconciliation (1)");
    expect(md).toContain(
      "`POST /api/organizations` - README says anonymous, observed single_resource_admin on Organization",
    );
  });

  it("groups the operations whose spec response is an inline unnamed schema", () => {
    // POST /api/follows declares an inline object; POST /api/articles a $ref
    const md = renderReport(
      [
        { kind: "matched", template: "/api/follows", method: "POST" },
        { kind: "matched", template: "/api/articles", method: "POST" },
      ],
      "ae359ff41b2a",
      "http://localhost:3000",
    );
    expect(md).toContain("## Inline unnamed response schemas (1)");
    expect(md).toContain("`POST /api/follows` - matched; the spec never named this shape");
  });

  it("counts every classification group, summing to the operation total", () => {
    const findings: Finding[] = specOperations().map((o) => ({
      kind: "matched",
      template: o.template,
      method: o.method,
    }));
    const md = renderReport(findings, "ae359ff41b2a", "http://localhost:3000");
    expect(md).toContain("130 operations classified");
    expect(md).toContain("| matched | 130 |");
  });

  it("gives the confirmed-empty verdict its own section and counts row", () => {
    const md = renderReport(
      [{ kind: "confirmed-empty", template: "/api/users/{id}/suspend", method: "PUT" }],
      "ae359ff41b2a",
      "http://localhost:3000",
    );
    expect(md).toContain("| confirmed-empty | 1 |");
    expect(md).toContain("## Confirmed empty (1)");
    expect(md).toContain("`PUT /api/users/{id}/suspend`");
  });
});
