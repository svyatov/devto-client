import type { OpTable } from "../ops.ts";

export const openapiTable = {
  get: { path: "/api/v1/openapi.json", verb: "get" },
} as const;

openapiTable satisfies OpTable;

export type { OpenapiNamespace } from "../generated/signatures.ts";
