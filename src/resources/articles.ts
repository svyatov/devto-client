import type { ArticlesNamespace } from "../generated/signatures.ts";
import type { OpTable } from "../ops.ts";

export const articlesTable = {
  list: { path: "/api/articles", verb: "get", paginated: true },
  latest: { path: "/api/articles/latest", verb: "get", paginated: true },
  search: { path: "/api/articles/search", verb: "get", paginated: true },
  semanticSearch: { path: "/api/articles/semantic_search", verb: "get", paginated: true },
  create: { path: "/api/articles", verb: "post", bodyKey: "article" },
  get: { path: "/api/articles/{id}", verb: "get" },
  update: { path: "/api/articles/{id}", verb: "put", bodyKey: "article" },
  unpublish: { path: "/api/articles/{id}/unpublish", verb: "put" },
  getByPath: { path: "/api/articles/{username}/{slug}", verb: "get" },
  me: { path: "/api/articles/me", verb: "get", paginated: true },
  mePublished: { path: "/api/articles/me/published", verb: "get", paginated: true },
  meUnpublished: { path: "/api/articles/me/unpublished", verb: "get", paginated: true },
  meAllStatuses: { path: "/api/articles/me/all", verb: "get", paginated: true },
} as const;

articlesTable satisfies OpTable;

export type { ArticlesNamespace };

/** Forem permits article tags only as an array and drops a string, so split one on commas. */
function splitTags<T extends { tags?: string | string[] }>(params: T | undefined): T | undefined {
  if (typeof params?.tags !== "string") return params;
  const tags = params.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return { ...params, tags };
}

/** Wraps create/update so a comma-separated `tags` string reaches Forem as an array. */
export function withArrayTags(ns: ArticlesNamespace): ArticlesNamespace {
  return {
    ...ns,
    create: (params, opts) => ns.create(splitTags(params), opts),
    update: (id, params, opts) => ns.update(id, splitTags(params), opts),
  };
}
