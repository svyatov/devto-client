import type { OpTable } from "../ops.ts";

export const surveysTable = {
  list: { path: "/api/surveys", verb: "get", paginated: true },
  create: { path: "/api/surveys", verb: "post", bodyKey: "survey" },
  get: { path: "/api/surveys/{id_or_slug}", verb: "get" },
  update: { path: "/api/surveys/{id_or_slug}", verb: "patch", bodyKey: "survey" },
  delete: { path: "/api/surveys/{id_or_slug}", verb: "delete" },
  pollTextResponses: { path: "/api/surveys/{id_or_slug}/poll_text_responses", verb: "get" },
  pollVotes: { path: "/api/surveys/{id_or_slug}/poll_votes", verb: "get" },
} as const;

surveysTable satisfies OpTable;

export type { SurveysNamespace } from "../generated/signatures.ts";
