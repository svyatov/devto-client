import type { BoundOps, OpTable } from "../ops.ts";

// GET /api/followers/organizations is deliberately absent: the route exists in
// forem but the controller action does not — a dead stub, excluded per R3.
export const followersTable = {
  users: { path: "/api/followers/users", verb: "get", paginated: true },
} as const;

followersTable satisfies OpTable;

export type FollowersNamespace = BoundOps<typeof followersTable>;
