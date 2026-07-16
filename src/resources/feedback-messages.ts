import type { BoundOps, OpTable } from "../ops.ts";

export const feedbackMessagesTable = {
  update: { path: "/api/feedback_messages/{id}", verb: "patch" },
} as const;

feedbackMessagesTable satisfies OpTable;

export type FeedbackMessagesNamespace = BoundOps<typeof feedbackMessagesTable>;
