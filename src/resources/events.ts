import type { OpTable } from "../ops.ts";

export const eventsTable = {
  list: { path: "/api/events", verb: "get" },
  create: { path: "/api/events", verb: "post", bodyKey: "event" },
  get: { path: "/api/events/{id}", verb: "get" },
  update: { path: "/api/events/{id}", verb: "patch", bodyKey: "event" },
  delete: { path: "/api/events/{id}", verb: "delete" },
} as const;

eventsTable satisfies OpTable;

export type { EventsNamespace } from "../generated/signatures.ts";
