import type { BoundOps, OpTable } from "../ops.ts";

export const feedbackMessagesTable = {
  update: { path: "/api/feedback_messages/{id}", verb: "patch" },
} as const;

feedbackMessagesTable satisfies OpTable;

/** Feedback messages: update the status of an abuse/feedback report. Requires moderator credentials. */
export type FeedbackMessagesNamespace = BoundOps<typeof feedbackMessagesTable>;
