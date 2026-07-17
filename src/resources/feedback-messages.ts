import type { OpTable } from "../ops.ts";

export const feedbackMessagesTable = {
  update: { path: "/api/feedback_messages/{id}", verb: "patch", bodyKey: "feedback_message" },
} as const;

feedbackMessagesTable satisfies OpTable;

export type { FeedbackMessagesNamespace } from "../generated/signatures.ts";
