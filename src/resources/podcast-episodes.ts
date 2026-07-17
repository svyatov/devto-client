import type { OpTable } from "../ops.ts";

export const podcastEpisodesTable = {
  list: { path: "/api/podcast_episodes", verb: "get", paginated: true },
} as const;

podcastEpisodesTable satisfies OpTable;

export type { PodcastEpisodesNamespace } from "../generated/signatures.ts";
