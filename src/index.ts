export { DevToClient } from "./client.ts";
export { DevToApiError, type ErrorEnvelope } from "./errors.ts";
// Friendly types (KTD5): `DevTo` is the namespace home for every alias (zero
// collisions), plus a curated flat re-export of the names that don't clash with
// a `lib.dom` global. The two that do — `Comment` and `RequestRedirect` (fetch's
// redirect mode) — are reachable only as `DevTo.Comment` / `DevTo.RequestRedirect`.
export type * as DevTo from "./generated/schemas.ts";
export type {
  AdminUser,
  AdminUserIdentity,
  AdminUserNote,
  AgentSession,
  AgentSessionSummary,
  Article,
  ArticleSummary,
  Badge,
  BadgeAchievement,
  Billboard,
  Concept,
  ExtendedUser,
  FollowedTag,
  HealthCheckMessage,
  MyArticle,
  MyUser,
  Organization,
  OrganizationSummary,
  Page,
  PodcastEpisodeSummary,
  PollTextResponse,
  PollVote,
  ReactionResult,
  ReadingListItem,
  RecommendedArticlesList,
  Segment,
  SegmentBulkResult,
  Subforem,
  Survey,
  SurveyWithPolls,
  Tag,
  Trend,
  User,
  VideoArticle,
} from "./generated/schemas.ts";
export type { ClientOptions, RequestOptions, RetryOptions } from "./http.ts";
export type { AdminConceptsNamespace } from "./resources/admin-concepts.ts";
export type { AdminRequestRedirectsNamespace } from "./resources/admin-request-redirects.ts";
export type { AdminUsersNamespace } from "./resources/admin-users.ts";
export type { AgentSessionsNamespace } from "./resources/agent-sessions.ts";
export type { AnalyticsNamespace } from "./resources/analytics.ts";
export type { ArticlesNamespace } from "./resources/articles.ts";
export type { BadgeAchievementsNamespace } from "./resources/badge-achievements.ts";
export type { BadgesNamespace } from "./resources/badges.ts";
export type { BillboardsNamespace } from "./resources/billboards.ts";
export type { CommentsNamespace } from "./resources/comments.ts";
export type { ConceptsNamespace } from "./resources/concepts.ts";
export type { FeedbackMessagesNamespace } from "./resources/feedback-messages.ts";
export type { FollowersNamespace } from "./resources/followers.ts";
export type { FollowsNamespace } from "./resources/follows.ts";
export type { HealthChecksNamespace } from "./resources/health-checks.ts";
export type { InstanceNamespace } from "./resources/instance.ts";
export type { OrganizationsNamespace } from "./resources/organizations.ts";
export type { PagesNamespace } from "./resources/pages.ts";
export type { PodcastEpisodesNamespace } from "./resources/podcast-episodes.ts";
export type { ProfileImagesNamespace } from "./resources/profile-images.ts";
export type { ReactionsNamespace } from "./resources/reactions.ts";
export type { ReadinglistNamespace } from "./resources/readinglist.ts";
export type { RecommendedArticlesListsNamespace } from "./resources/recommended-articles-lists.ts";
export type { SegmentsNamespace } from "./resources/segments.ts";
export type { SubforemsNamespace } from "./resources/subforems.ts";
export type { SurveysNamespace } from "./resources/surveys.ts";
export type { TagsNamespace } from "./resources/tags.ts";
export type { TrendsNamespace } from "./resources/trends.ts";
export type { UsersNamespace } from "./resources/users.ts";
export type { VideosNamespace } from "./resources/videos.ts";
