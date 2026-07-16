import type { BoundOps, OpTable } from "../ops.ts";

export const podcastEpisodesTable = {
  list: { path: "/api/podcast_episodes", verb: "get", paginated: true },
} as const;

podcastEpisodesTable satisfies OpTable;

export type PodcastEpisodesNamespace = BoundOps<typeof podcastEpisodesTable>;
