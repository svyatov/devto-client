import type { OpTable } from "../ops.ts";

export const profileImagesTable = {
  get: { path: "/api/profile_images/{username}", verb: "get" },
} as const;

profileImagesTable satisfies OpTable;

export type { ProfileImagesNamespace } from "../generated/signatures.ts";
