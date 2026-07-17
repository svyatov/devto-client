import type { BoundOps, OpTable } from "../ops.ts";

export const profileImagesTable = {
  get: { path: "/api/profile_images/{username}", verb: "get" },
} as const;

profileImagesTable satisfies OpTable;

/** A user's profile-image URLs, looked up by username. */
export type ProfileImagesNamespace = BoundOps<typeof profileImagesTable>;
