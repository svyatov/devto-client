import type { BoundOps, OpTable } from "../ops.ts";

export const healthChecksTable = {
  app: { path: "/api/health_checks/app", verb: "get" },
  cache: { path: "/api/health_checks/cache", verb: "get" },
  database: { path: "/api/health_checks/database", verb: "get" },
} as const;

healthChecksTable satisfies OpTable;

export type HealthChecksNamespace = BoundOps<typeof healthChecksTable>;
