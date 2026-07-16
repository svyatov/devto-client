import { describe, expect, expectTypeOf, it } from "vitest";
import { DevToClient } from "../src/client.ts";
import { DevToApiError } from "../src/errors.ts";
import { bindOps } from "../src/ops.ts";
import type { components } from "../src/generated/types.ts";

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
  return { client: new DevToClient({ apiKey: "k", fetch }), calls };
}

describe("namespace bindings", () => {
  it("articles.getByPath hits /api/articles/{username}/{slug}", async () => {
    const { client, calls } = harness({});
    await client.articles.getByPath({ path: { username: "jess", slug: "some-post" } });
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "https://dev.to/api/articles/jess/some-post",
    });
  });

  it("URL-encodes path params", async () => {
    const { client, calls } = harness({});
    await client.articles.get({ path: { id: "a/b" as unknown as number } });
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

  it("reactions.toggle sends query params, not a body", async () => {
    const { client, calls } = harness({
      result: "create",
      category: "like",
      id: 1,
      reactable_id: 7,
      reactable_type: "Article",
    });
    const result = await client.reactions.toggle({
      query: { category: "like", reactable_id: 7, reactable_type: "Article" },
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://dev.to/api/reactions/toggle?category=like&reactable_id=7&reactable_type=Article",
      body: null,
    });
    expect(result.result).toBe("create");
  });

  it("articles.create sends the JSON body and returns the typed Article", async () => {
    const { client, calls } = harness({ id: 1, title: "hi", type_of: "article" });
    const created = await client.articles.create({
      body: { article: { title: "hi", body_markdown: "text", published: false } },
    });
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      article: { title: "hi", body_markdown: "text", published: false },
    });
    expectTypeOf(created).toEqualTypeOf<components["schemas"]["Article"]>();
  });

  it("update uses the documented verb only (PUT for articles, PATCH for concepts)", async () => {
    const { client, calls } = harness({}, {});
    await client.articles.update({ path: { id: 1 }, body: { article: { published: true } } });
    await client.concepts.update({ path: { id: 1 }, body: {} });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "PATCH"]);
  });

  it("billboards.unpublish hits PUT /api/billboards/{id}/unpublish", async () => {
    const { client, calls } = harness({});
    await client.billboards.unpublish({ path: { id: 3 } });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "https://dev.to/api/billboards/3/unpublish",
    });
  });

  it("segments add/remove users send arrays in the body", async () => {
    const { client, calls } = harness({}, {});
    await client.segments.addUsers({ path: { id: 5 }, body: { user_ids: [1, 2, 3] } });
    await client.segments.removeUsers({ path: { id: 5 }, body: { user_ids: [4] } });
    expect(calls[0]?.url).toBe("https://dev.to/api/segments/5/add_users");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ user_ids: [1, 2, 3] });
    expect(calls[1]?.url).toBe("https://dev.to/api/segments/5/remove_users");
  });

  it("admin user status update sends the documented body", async () => {
    const { client, calls } = harness({});
    await client.admin.users.updateStatus({
      path: { id: 9 },
      body: { status: "Suspended", note: "spam" },
    });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "https://dev.to/api/admin/users/9/status",
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ status: "Suspended", note: "spam" });
  });

  it("missing path params throw before any request is made", async () => {
    const { client, calls } = harness();
    await expect(
      // @ts-expect-error — path arg is required
      client.articles.get(),
    ).rejects.toThrow(/missing path param/);
    expect(calls).toHaveLength(0);
  });

  it("agent session undocumented extras are flagged in the table and callable", async () => {
    const { client, calls } = harness(
      { s3_key: "k", presigned_url: "https://s3" },
      { raw_url: "https://s3/raw" },
    );
    const presigned = await client.agentSessions.presign();
    const raw = await client.agentSessions.rawUrl({ path: { id: "42" } });
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
        ? new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
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
  it("paginated lists expose an All iterator that pages until empty", async () => {
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
    for await (const article of client.articles.listAll({ query: { tag: "go", per_page: 2 } })) {
      seen.push(article.id as number);
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(calls[0]?.url).toContain("tag=go");
    expect(calls[0]?.url).toContain("per_page=2");
    expect(calls[0]?.url).toContain("page=1");
    expect(calls).toHaveLength(3);
  });
});

describe("bindOps guards", () => {
  it("passes an AbortSignal through to the request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { client, calls } = harness();
    await expect(client.articles.list({ signal: controller.signal })).rejects.toThrow(/stop/);
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
    void client.articles.getByPath({ path: { username: "jess" } }).catch(() => {});
    // @ts-expect-error — update body must be the documented article payload wrapper
    void client.articles.update({ path: { id: 1 }, body: { title: "raw" } }).catch(() => {});
    // @ts-expect-error — no such verb on this path: comments are read-only
    void client.comments.create;
    expect(true).toBe(true);
  });
});
