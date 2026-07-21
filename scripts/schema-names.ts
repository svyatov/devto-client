/**
 * Explicit `SchemaName → FriendlyName` map (KTD1). Every schema that surfaces
 * publicly as an operation's success *response* gets a hand-chosen friendly
 * alias here; the generator emits `export type FriendlyName =
 * components["schemas"]["SchemaName"]` into `src/generated/schemas.ts` from it.
 *
 * Response-only by design (KTD2): body inputs and query params are handled
 * structurally by the `CallBody*` / `CallQuery` helpers and never appear here,
 * which is why a distinct schema literally named `Article` (the create/update
 * body) has no entry and does not collide with `ArticleShow → Article`.
 *
 * Names are 1:1 aliases, never merged god-types (R4). Most schemas are already
 * domain nouns and keep their name; the exceptions are Rails action suffixes
 * that leak plumbing into the hover (`Show`/`Index`). Those get de-plumbing'd
 * so a result reads as intent, not a controller action (R1):
 *   `ArticleShow → Article`, `ArticleIndex → ArticleSummary`,
 *   `AgentSessionShow → AgentSession`, `AgentSessionIndex → AgentSessionSummary`,
 *   `PodcastEpisodeIndex → PodcastEpisodeSummary`.
 *
 * KTD2's completeness gate lives in `generate-signatures.ts`: a branch-1/2
 * response schema absent from this map fails generation.
 */
export const schemaNames = {
  // article family
  ArticleShow: "Article",
  ArticleIndex: "ArticleSummary",
  MyArticle: "MyArticle",
  VideoArticle: "VideoArticle",
  ReadingListItem: "ReadingListItem",
  // users
  User: "User",
  MyUser: "MyUser",
  ExtendedUser: "ExtendedUser",
  // social graph
  Comment: "Comment",
  Organization: "Organization",
  OrganizationSummary: "OrganizationSummary",
  Tag: "Tag",
  FollowedTag: "FollowedTag",
  // content
  Page: "Page",
  PodcastEpisodeIndex: "PodcastEpisodeSummary",
  Badge: "Badge",
  BadgeAchievement: "BadgeAchievement",
  Billboard: "Billboard",
  // segments & sessions
  Segment: "Segment",
  SegmentBulkResult: "SegmentBulkResult",
  AgentSessionShow: "AgentSession",
  AgentSessionIndex: "AgentSessionSummary",
  // surveys & polls
  Survey: "Survey",
  SurveyWithPolls: "SurveyWithPolls",
  PollVote: "PollVote",
  PollTextResponse: "PollTextResponse",
  // discovery
  Trend: "Trend",
  Concept: "Concept",
  RequestRedirect: "RequestRedirect",
  RecommendedArticlesList: "RecommendedArticlesList",
  Subforem: "Subforem",
  ReactionResult: "ReactionResult",
  HealthCheckMessage: "HealthCheckMessage",
  // admin
  AdminUser: "AdminUser",
  AdminUserIdentity: "AdminUserIdentity",
  AdminUserNote: "AdminUserNote",
} as const;

export type SchemaName = keyof typeof schemaNames;
export type FriendlyName = (typeof schemaNames)[SchemaName];
