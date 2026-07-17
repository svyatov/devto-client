import type { BoundOps, OpTable } from "../ops.ts";

export const usersTable = {
  get: { path: "/api/users/{id}", verb: "get" },
  me: { path: "/api/users/me", verb: "get" },
  search: { path: "/api/users/search", verb: "get" },
  // moderation roles — require appropriate privileges
  limit: { path: "/api/users/{id}/limited", verb: "put" },
  unlimit: { path: "/api/users/{id}/limited", verb: "delete" },
  markSpam: { path: "/api/users/{id}/spam", verb: "put" },
  unmarkSpam: { path: "/api/users/{id}/spam", verb: "delete" },
  suspend: { path: "/api/users/{id}/suspend", verb: "put" },
  trust: { path: "/api/users/{id}/trusted", verb: "put" },
  untrust: { path: "/api/users/{id}/trusted", verb: "delete" },
  unpublishContent: { path: "/api/users/{id}/unpublish", verb: "put" },
} as const;

usersTable satisfies OpTable;

/** Users: public profile reads, the authenticated `me` profile, and moderation actions (limit, spam, suspend, trust, unpublish) that require moderator credentials. */
export type UsersNamespace = BoundOps<typeof usersTable>;
