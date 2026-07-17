import type { OpTable } from "../ops.ts";

export const agentSessionsTable = {
  list: { path: "/api/agent_sessions", verb: "get" },
  create: { path: "/api/agent_sessions", verb: "post" },
  get: { path: "/api/agent_sessions/{id}", verb: "get" },
  /** @undocumented verified in forem routes, absent from upstream docs (KTD11) */
  presign: { path: "/api/agent_sessions/presign", verb: "post", undocumented: true },
  /** @undocumented verified in forem routes, absent from upstream docs (KTD11) */
  rawUrl: { path: "/api/agent_sessions/{id}/raw_url", verb: "get", undocumented: true },
} as const;

agentSessionsTable satisfies OpTable;

export type { AgentSessionsNamespace } from "../generated/signatures.ts";
