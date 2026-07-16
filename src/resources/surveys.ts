import type { BoundOps, OpTable } from "../ops.ts";

export const surveysTable = {
  list: { path: "/api/surveys", verb: "get", paginated: true },
  get: { path: "/api/surveys/{id_or_slug}", verb: "get" },
  pollTextResponses: { path: "/api/surveys/{id_or_slug}/poll_text_responses", verb: "get" },
  pollVotes: { path: "/api/surveys/{id_or_slug}/poll_votes", verb: "get" },
} as const;

surveysTable satisfies OpTable;

export type SurveysNamespace = BoundOps<typeof surveysTable>;
