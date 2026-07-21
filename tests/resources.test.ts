import { describe, expect, expectTypeOf, it } from "bun:test";
import { DevToClient } from "../src/client.ts";
import { DevToApiError } from "../src/errors.ts";
import type { components } from "../src/generated/types.ts";
import { bindOps } from "../src/ops.ts";
import { allTables } from "../src/resources/index.ts";

type Call = { method: string; url: string; body: string | null };

/** Client whose fetch records calls and replies with the given payloads in order. */
function harness(...payloads: unknown[]) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = payloads.shift();
    return new Response(JSON.stringify(next ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  // pace: false — these assert routing, not transport, and the default write
  // budget of 1/s would park the multi-write cases for a real second each
  return { client: new DevToClient({ apiKey: "k", fetch, pace: false }), calls };
}

describe("namespace bindings — the Call rule", () => {
  it("AE1: positional path params hit the right URLs (0-, 1-, 2-arity)", async () => {
    const { client, calls } = harness({}, {}, {});
    await client.articles.get(123);
    await client.articles.getByPath("jess", "some-post");
    await client.articles.list();
    expect(calls.map((c) => c.url)).toEqual([
      "https://dev.to/api/articles/123",
      "https://dev.to/api/articles/jess/some-post",
      "https://dev.to/api/articles",
    ]);
  });

  it("URL-encodes positional path params", async () => {
    const { client, calls } = harness({});
    await client.articles.get("a/b" as unknown as number);
    expect(calls[0]?.url).toBe("https://dev.to/api/articles/a%2Fb");
  });

  it("articles.me status variants map to the four documented paths", async () => {
    const { client, calls } = harness([], [], [], []);
    await client.articles.me();
    await client.articles.mePublished();
    await client.articles.meUnpublished();
    await client.articles.meAllStatuses();
    expect(calls.map((c) => c.url)).toEqual([
      "https://dev.to/api/articles/me",
      "https://dev.to/api/articles/me/published",
      "https://dev.to/api/articles/me/unpublished",
      "https://dev.to/api/articles/me/all",
    ]);
  });

  it("reactions.toggle sends flat params as query, not a body", async () => {
    const { client, calls } = harness({
      result: "create",
      category: "like",
      id: 1,
      reactable_id: 7,
      reactable_type: "Article",
    });
    const result = await client.reactions.toggle({
      category: "like",
      reactable_id: 7,
      reactable_type: "Article",
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://dev.to/api/reactions/toggle?category=like&reactable_id=7&reactable_type=Article",
      body: null,
    });
    expect(result.result).toBe("create");
  });

  it("AE2/R3: create wraps flat inner fields under the bodyKey and returns the typed Article", async () => {
    const { client, calls } = harness({ id: 1, title: "hi", type_of: "article" });
    const created = await client.articles.create({
      title: "hi",
      body_markdown: "text",
      published: false,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      article: { title: "hi", body_markdown: "text", published: false },
    });
    expectTypeOf(created).toEqualTypeOf<components["schemas"]["ArticleShow"]>();
    expectTypeOf(created.body_markdown).toEqualTypeOf<string | null>();
  });

  it("AE2: update sends the wrapped body with the path id, documented verbs only", async () => {
    const { client, calls } = harness({}, {});
    await client.articles.update(1, { published: true });
    await client.concepts.update(1, {});
    expect(calls[0]).toMatchObject({ method: "PUT", url: "https://dev.to/api/articles/1" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ article: { published: true } });
    expect(calls[1]?.method).toBe("PATCH");
  });

  it("billboards.unpublish hits PUT /api/billboards/{id}/unpublish", async () => {
    const { client, calls } = harness({});
    await client.billboards.unpublish(3);
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "https://dev.to/api/billboards/3/unpublish",
    });
  });

  it("R3: a flat (non-wrapper) body op passes its fields through unwrapped", async () => {
    const { client, calls } = harness({}, {});
    await client.segments.addUsers(5, { user_ids: [1, 2, 3] });
    await client.segments.removeUsers(5, { user_ids: [4] });
    expect(calls[0]?.url).toBe("https://dev.to/api/segments/5/add_users");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ user_ids: [1, 2, 3] });
    expect(calls[1]?.url).toBe("https://dev.to/api/segments/5/remove_users");
  });

  it("admin user status update sends the documented flat body", async () => {
    const { client, calls } = harness({});
    await client.admin.users.updateStatus(9, { status: "Suspended", note: "spam" });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "https://dev.to/api/admin/users/9/status",
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ status: "Suspended", note: "spam" });
  });

  it("R7: missing positional path params reject before any request is made", async () => {
    const { client, calls } = harness();
    await expect(
      // @ts-expect-error — id path param is required
      client.articles.get(),
    ).rejects.toThrow(/missing path param/);
    expect(calls).toHaveLength(0);
  });

  it("AE5: the trailing options argument carries signal, keeping transport out of params", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { client, calls } = harness();
    await expect(
      client.articles.search({ q: "test" }, { signal: controller.signal }),
    ).rejects.toThrow(/stop/);
    expect(calls).toHaveLength(0);
  });

  it("agent session undocumented extras are flagged in the table and callable", async () => {
    const { client, calls } = harness(
      { s3_key: "k", presigned_url: "https://s3" },
      { raw_url: "https://s3/raw" },
    );
    const presigned = await client.agentSessions.presign();
    const raw = await client.agentSessions.rawUrl("42");
    expect(calls.map((c) => c.url)).toEqual([
      "https://dev.to/api/agent_sessions/presign",
      "https://dev.to/api/agent_sessions/42/raw_url",
    ]);
    expectTypeOf(presigned.presigned_url).toEqualTypeOf<string>();
    expectTypeOf(raw.raw_url).toEqualTypeOf<string>();
  });

  it("keyless call to a public endpoint succeeds; api-key endpoint surfaces the 401 shape", async () => {
    const fetch = (async (url: string | URL | Request) =>
      String(url).endsWith("/api/articles")
        ? new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ error: "unauthorized", status: 401 }), {
            status: 401,
          })) as typeof globalThis.fetch;
    const keyless = new DevToClient({ fetch });
    await expect(keyless.articles.list()).resolves.toEqual([]);
    const err = (await keyless.articles.me().catch((e: unknown) => e)) as DevToApiError;
    expect(err).toBeInstanceOf(DevToApiError);
    expect(err.status).toBe(401);
    expect(err.body).toEqual({ error: "unauthorized", status: 401 });
  });
});

describe("iterator variants", () => {
  it("AE4: paginated lists expose an All iterator that pages until empty", async () => {
    const pages: Record<string, unknown> = {
      "1": [{ id: 1 }, { id: 2 }],
      "2": [{ id: 3 }],
      "3": [],
    };
    const calls: Call[] = [];
    const fetch = (async (url: string | URL | Request) => {
      calls.push({ method: "GET", url: String(url), body: null });
      const page = new URL(String(url)).searchParams.get("page") ?? "1";
      return new Response(JSON.stringify(pages[page] ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const client = new DevToClient({ fetch });

    const seen: number[] = [];
    for await (const article of client.articles.listAll({ tag: "go", per_page: 2 })) {
      seen.push(article.id as number);
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(calls[0]?.url).toContain("tag=go");
    expect(calls[0]?.url).toContain("per_page=2");
    expect(calls[0]?.url).toContain("page=1");
    expect(calls).toHaveLength(3);
  });

  it("an iterator over a path-parametrized paginated op keeps the positional id", async () => {
    const { client, calls } = harness([]);
    for await (const _ of client.concepts.articlesAll(7)) {
      // no items — the empty page terminates immediately
    }
    expect(calls[0]?.url).toContain("/api/concepts/7/articles");
    expect(calls[0]?.url).toContain("page=1");
  });

  it("AE5: the `<name>All` iterator forwards a trailing AbortSignal past a path id", async () => {
    // Exercises the iterator's opts index at pathNames.length + 1 with a
    // positional id present: concepts.articlesAll(id, params, { signal }).
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { client } = harness();
    await expect(
      client.concepts.articlesAll(7, {}, { signal: controller.signal }).next(),
    ).rejects.toThrow(/stop/);
  });
});

describe("namespace/table pairing", () => {
  // bindOps<N> no longer type-links its N to the table argument (KTD2), so a
  // wrong-table bind (`bindOps<ArticlesNamespace>(rf, usersTable)`) compiles.
  // This walks the same key→table map the client construction mirrors and
  // asserts each client namespace exposes exactly its own table's methods.
  it("binds every client namespace to its own table's methods", () => {
    const { client } = harness();
    for (const [key, table] of Object.entries(allTables)) {
      const ns = key
        .split(".")
        .reduce((obj, seg) => (obj as Record<string, unknown>)[seg], client as unknown) as Record<
        string,
        unknown
      >;
      const expected = new Set(
        Object.entries(table).flatMap(([name, entry]) =>
          entry.paginated ? [name, `${name}All`] : [name],
        ),
      );
      expect(new Set(Object.keys(ns))).toEqual(expected);
    }
  });
});

describe("bindOps guards", () => {
  it("AE5: passes an AbortSignal through a query op with params omitted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { client, calls } = harness();
    await expect(client.articles.list(undefined, { signal: controller.signal })).rejects.toThrow(
      /stop/,
    );
    expect(calls).toHaveLength(0);
  });

  it("AE5: passes an AbortSignal through a no-query/no-body op (opts follows the path arg)", async () => {
    // billboards.unpublish has no query and no body, so opts sits at the
    // pathNames.length + 0 index — the branch every other signal test skips.
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { client, calls } = harness();
    await expect(client.billboards.unpublish(3, { signal: controller.signal })).rejects.toThrow(
      /stop/,
    );
    expect(calls).toHaveLength(0);
  });

  it("iterator variant works without an explicit per_page", async () => {
    const { client } = harness([], []);
    const items: unknown[] = [];
    for await (const t of client.tags.listAll()) items.push(t);
    expect(items).toEqual([]);
  });

  it("rejects a table key that collides with an iterator variant", () => {
    const table = {
      list: { path: "/api/articles", verb: "get", paginated: true },
      listAll: { path: "/api/articles/latest", verb: "get" },
    } as unknown as Parameters<typeof bindOps>[1];
    expect(() => bindOps(async () => ({}) as never, table)).toThrow(/collides/);
  });
});

describe("type-level enforcement", () => {
  it("compile-time contracts hold", () => {
    const { client } = harness();
    // @ts-expect-error — getByPath requires both username and slug
    void client.articles.getByPath("jess").catch(() => {});
    // @ts-expect-error — an unknown inner field is rejected by the flattened body type
    void client.articles.update(1, { not_a_field: true }).catch(() => {});
    // @ts-expect-error — no such verb on this path: comments are read-only
    void client.comments.create;
    expect(true).toBe(true);
  });
});
