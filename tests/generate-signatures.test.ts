import { describe, expect, it, vi } from "bun:test";
import {
  generate,
  loadObservation,
  loadSpec,
  namespaceName,
  never404Candidates,
} from "../scripts/generate-signatures.ts";
import { observe } from "../scripts/observe-never-404.ts";
import { escapeRegex } from "../scripts/spec-templates.ts";
import { pathParamNames } from "../src/path-template.ts";
import { allTables } from "../src/resources/index.ts";

/**
 * The generator's contract: labeled Call-rule members with true names/order/types,
 * derived from the composed spec + op tables. Assertions match the raw (pre-Biome)
 * single-line output `generate()` returns.
 */
const spec = loadSpec();
const observation = loadObservation();
const { signatures, schemas, routing } = generate(spec, observation);

/** The observation with `key` dropped, for the candidate-without-evidence cases. */
const observationWithout = (key: string): unknown => {
  const { [key]: _dropped, ...rest } = observation.operations;
  return { ...observation, operations: rest };
};

/** Members of the emitted `NEVER_404` set literal, one per indented line. */
const emittedSet = (routingOutput: string): string[] =>
  [...(routingOutput.split("NEVER_404").at(-1) ?? "").matchAll(/^ {2}"([^"]+)",$/gm)].map(
    (m) => m[1] as string,
  );

describe("generate-signatures", () => {
  it("emits 0-, 1-, and 2-arity path signatures with true names, order, and types", () => {
    expect(signatures).toContain("get: (id: number, opts?: CallOptions) => Promise<Article>;");
    expect(signatures).toContain(
      "getByPath: (username: string, slug: string, opts?: CallOptions) => Promise<Article>;",
    );
    // 0-arity op with only optional query keeps the params object optional
    expect(signatures).toContain(
      "list: (params?: ArticleListParams, opts?: CallOptions) => Promise<ArticleSummary[]>;",
    );
  });

  it("makes the params object required for a required-query op (AE3), optional otherwise", () => {
    // the `?` on the slot carries required-vs-optional; the type is the named alias
    expect(signatures).toContain("semanticSearch: (params: ArticleSemanticSearchParams,");
    expect(signatures).toContain("search: (params?: ArticleSearchParams,");
  });

  it("unwraps a single-key body op to flat inner fields, leaves a flat body unchanged", () => {
    // the unwrap distinction now lives in the param alias definition (schemas.ts):
    // wrapper op → CallBodyInner keyed by bodyKey
    expect(schemas).toContain(
      'export type ArticleCreateParams = Prettify<CallBodyInner<"/api/articles", "post", "article">>;',
    );
    // flat-body op (UserInviteParam { email, name }) → CallBody, no unwrap
    expect(schemas).toContain(
      'export type AdminUserCreateParams = Prettify<CallBody<"/api/admin/users", "post">>;',
    );
  });

  it("emits an `<name>All` iterator twin for paginated ops", () => {
    expect(signatures).toContain(
      'listAll: (params?: ArticleListAllParams, opts?: CallOptions) => IterResult<"/api/articles", "get">;',
    );
    // a non-paginated op gets no twin
    expect(signatures).not.toContain("getByPathAll:");
  });

  it("routes params to query vs body per op kind", () => {
    expect(routing).toContain('"post /api/articles": "body"');
    expect(routing).toContain('"get /api/articles": "query"');
    expect(routing).toContain('"post /api/reactions/toggle": "query"');
    // no-params ops are absent from the routing manifest
    expect(routing).not.toContain('"get /api/articles/{id}":');
    expect(routing).not.toContain('"get /api/articles/{username}/{slug}":');
  });

  it("gives every op exactly its path-template positional arity, over all tables", () => {
    // Leading `name: primitive` slots, before the flat `params`/`opts` slots.
    const positionalArity = (args: string): number => {
      let n = 0;
      for (const part of args.split(", ")) {
        if (part.startsWith("params") || part.startsWith("opts")) break;
        n++;
      }
      return n;
    };
    // Friendly returns (Promise<Article>) drop the path/verb anchor, so locate
    // each member inside its own namespace block, member names are unique there.
    const blockOf = (iface: string): string => {
      const m = signatures.match(new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`));
      if (!m) throw new Error(`no interface ${iface}`);
      return m[1] as string;
    };
    const argsOf = (block: string, member: string): string => {
      const m = block.match(new RegExp(`\\b${escapeRegex(member)}: \\(([^)]*)\\) =>`));
      if (!m) throw new Error(`no member ${member}`);
      return m[1] as string;
    };

    let checked = 0;
    for (const [resourceKey, table] of Object.entries(allTables)) {
      const block = blockOf(namespaceName(resourceKey));
      for (const [name, entry] of Object.entries(table)) {
        const expected = pathParamNames(entry.path).length;
        expect(positionalArity(argsOf(block, name))).toBe(expected);
        checked++;
        if (entry.paginated) {
          expect(positionalArity(argsOf(block, `${name}All`))).toBe(expected);
          checked++;
        }
      }
    }
    // Non-vacuity: the loop actually exercised the whole surface, incl. 0/1/2-arity ops.
    expect(checked).toBeGreaterThan(30);
  });

  it("is deterministic: regenerating produces byte-identical output", () => {
    const again = generate(spec, observation);
    expect(again.signatures).toBe(signatures);
    expect(again.routing).toBe(routing);
  });

  it("fails with a named error when an op references a path absent from the spec", () => {
    const empty = { ...spec, paths: {} };
    expect(() => generate(empty, observation)).toThrow(/absent from the composed spec/);
  });
});

describe("the never-404 set (U1)", () => {
  it("proposes only GET ops with no path params and no declared 404", () => {
    const candidates = never404Candidates(spec);
    expect(candidates.length).toBeGreaterThan(30);
    for (const key of candidates) {
      const path = key.replace(/^get /, "");
      expect(key, key).toStartWith("get ");
      expect(pathParamNames(path), key).toEqual([]);
      const op = spec.paths[path]?.get as { responses?: Record<string, unknown> } | undefined;
      expect(Object.keys(op?.responses ?? {}), key).not.toContain("404");
    }
    // the two exclusions, against the spec as it stands: a declared 404 and a path param
    expect(candidates).not.toContain("get /api/comments");
    expect(candidates).not.toContain("get /api/articles/{id}");
    expect(candidates).toContain("get /api/tags");
  });

  it("counts only a fresh entry: a candidate that always replays is unobserved", async () => {
    const replay = async (): Promise<{ status: number; fromCache: boolean }> => ({
      status: 200,
      fromCache: true,
    });
    const walked = await observe(replay, ["get /api/tags"]);
    expect(walked.operations).toEqual({});
    expect(walked.unobserved).toEqual(["get /api/tags"]);
  });

  it("admits on the first fresh probe and rejects a fresh 404", async () => {
    const fresh =
      (status: number) => async (): Promise<{ status: number; fromCache: boolean }> => ({
        status,
        fromCache: false,
      });
    expect((await observe(fresh(200), ["get /api/tags"])).operations).toEqual({
      "get /api/tags": { status: 200 },
    });
    expect((await observe(fresh(404), ["get /api/tags"])).rejected).toEqual(["get /api/tags"]);
  });

  it("emits nothing for an observation the spec no longer proposes as a candidate", () => {
    // a stale entry must not resurrect a set member once the spec declares a 404 for it
    const stale = {
      ...observation,
      operations: { ...observation.operations, "get /api/comments": { status: 200 } },
    };
    expect(emittedSet(generate(spec, stale).routing)).not.toContain("get /api/comments");
  });

  it("emits nothing for a candidate with no observation, and warns naming it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitted = emittedSet(generate(spec, observationWithout("get /api/tags")).routing);
    expect(emitted).not.toContain("get /api/tags");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("get /api/tags"));
    warn.mockRestore();
  });

  it("keys the set exactly like opRouting", () => {
    expect(emittedSet(routing)).toContain("get /api/tags");
    expect(routing).toContain('"get /api/tags": "query"');
  });

  it("refuses a malformed observation rather than emitting a partial set", () => {
    expect(() => generate(spec, {})).toThrow(/provenance is missing/);
    expect(() =>
      generate(spec, {
        ...observation,
        provenance: { ...observation.provenance, instrument: "vibes" },
      }),
    ).toThrow(/instrument must be one of/);
    expect(() =>
      generate(spec, { ...observation, provenance: { ...observation.provenance, tier: "" } }),
    ).toThrow(/tier must be a non-empty string/);
    expect(() => generate(spec, { ...observation, operations: { "get /api/tags": {} } })).toThrow(
      /must record the status/,
    );
  });
});
