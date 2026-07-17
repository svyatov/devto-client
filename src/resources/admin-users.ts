import type { OpTable } from "../ops.ts";

export const adminUsersTable = {
  list: { path: "/api/admin/users", verb: "get", paginated: true },
  create: { path: "/api/admin/users", verb: "post" },
  get: { path: "/api/admin/users/{id}", verb: "get" },
  update: { path: "/api/admin/users/{id}", verb: "patch" },
  updateEmail: { path: "/api/admin/users/{id}/email", verb: "put" },
  merge: { path: "/api/admin/users/{id}/merge", verb: "post" },
  updateNotificationSettings: {
    path: "/api/admin/users/{id}/notification_settings",
    verb: "put",
    bodyKey: "notification_setting",
  },
  updateStatus: { path: "/api/admin/users/{id}/status", verb: "put" },
  identities: { path: "/api/admin/users/{user_id}/identities", verb: "get" },
  createIdentity: { path: "/api/admin/users/{user_id}/identities", verb: "post" },
  deleteIdentity: { path: "/api/admin/users/{user_id}/identities/{id}", verb: "delete" },
  identitiesBulk: { path: "/api/admin/users/identities/bulk", verb: "post" },
  notes: { path: "/api/admin/users/{user_id}/notes", verb: "get" },
  createNote: { path: "/api/admin/users/{user_id}/notes", verb: "post" },
} as const;

adminUsersTable satisfies OpTable;

export type { AdminUsersNamespace } from "../generated/signatures.ts";
