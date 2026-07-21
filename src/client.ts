import {
  type ClientOptions,
  type RequestOptions,
  type ResolvedConfig,
  request,
  resolveConfig,
} from "./http.ts";
import { bindOps, type RequestFn } from "./ops.ts";
import { type AdminConceptsNamespace, adminConceptsTable } from "./resources/admin-concepts.ts";
import {
  type AdminRequestRedirectsNamespace,
  adminRequestRedirectsTable,
} from "./resources/admin-request-redirects.ts";
import { type AdminUsersNamespace, adminUsersTable } from "./resources/admin-users.ts";
import { type AgentSessionsNamespace, agentSessionsTable } from "./resources/agent-sessions.ts";
import { type AnalyticsNamespace, analyticsTable } from "./resources/analytics.ts";
import { type ArticlesNamespace, articlesTable } from "./resources/articles.ts";
import {
  type BadgeAchievementsNamespace,
  badgeAchievementsTable,
} from "./resources/badge-achievements.ts";
import { type BadgesNamespace, badgesTable } from "./resources/badges.ts";
import { type BillboardsNamespace, billboardsTable } from "./resources/billboards.ts";
import { type CommentsNamespace, commentsTable } from "./resources/comments.ts";
import { type ConceptsNamespace, conceptsTable } from "./resources/concepts.ts";
import {
  type FeedbackMessagesNamespace,
  feedbackMessagesTable,
} from "./resources/feedback-messages.ts";
import { type FollowersNamespace, followersTable } from "./resources/followers.ts";
import { type FollowsNamespace, followsTable } from "./resources/follows.ts";
import { type HealthChecksNamespace, healthChecksTable } from "./resources/health-checks.ts";
import { type InstanceNamespace, instanceTable } from "./resources/instance.ts";
import { type OrganizationsNamespace, organizationsTable } from "./resources/organizations.ts";
import { type PagesNamespace, pagesTable } from "./resources/pages.ts";
import {
  type PodcastEpisodesNamespace,
  podcastEpisodesTable,
} from "./resources/podcast-episodes.ts";
import { type ProfileImagesNamespace, profileImagesTable } from "./resources/profile-images.ts";
import { type ReactionsNamespace, reactionsTable } from "./resources/reactions.ts";
import { type ReadinglistNamespace, readinglistTable } from "./resources/readinglist.ts";
import {
  type RecommendedArticlesListsNamespace,
  recommendedArticlesListsTable,
} from "./resources/recommended-articles-lists.ts";
import { type SegmentsNamespace, segmentsTable } from "./resources/segments.ts";
import { type SubforemsNamespace, subforemsTable } from "./resources/subforems.ts";
import { type SurveysNamespace, surveysTable } from "./resources/surveys.ts";
import { type TagsNamespace, tagsTable } from "./resources/tags.ts";
import { type TrendsNamespace, trendsTable } from "./resources/trends.ts";
import { type UsersNamespace, usersTable } from "./resources/users.ts";
import { type VideosNamespace, videosTable } from "./resources/videos.ts";

/**
 * Typed client for the dev.to (Forem) v1 API. Construct once and reuse; each
 * property is a resource namespace whose methods map to REST operations.
 * Public endpoints work keyless. Pass an api-key via {@link ClientOptions.apiKey}
 * for authenticated, moderation, and admin routes.
 */
export class DevToClient {
  private readonly config: ResolvedConfig;

  /** Articles: read, search, publish, and manage your own drafts via the `me` operations. Updating needs to be the article's author; unpublishing needs super_moderator credentials. */
  readonly articles: ArticlesNamespace;
  /** Comment threads on articles and podcast episodes. */
  readonly comments: CommentsNamespace;
  /** User profiles, plus moderation actions that require super_moderator credentials. */
  readonly users: UsersNamespace;
  /** Organizations, their members, and their articles. Mutations require being an admin of that organization. */
  readonly organizations: OrganizationsNamespace;
  /** The users following you. Requires authentication. */
  readonly followers: FollowersNamespace;
  /** Create a follow and list the tags you follow. */
  readonly follows: FollowsNamespace;
  /** The instance's tags. */
  readonly tags: TagsNamespace;
  /** Your saved-articles reading list. Requires authentication. */
  readonly readinglist: ReadinglistNamespace;
  /** Published podcast episodes. */
  readonly podcastEpisodes: PodcastEpisodesNamespace;
  /** Articles published with a video. */
  readonly videos: VideosNamespace;
  /** A user's profile-image URLs, looked up by username. */
  readonly profileImages: ProfileImagesNamespace;
  /** Create or toggle reactions. Admin-gated upstream; ordinary keys get 401. */
  readonly reactions: ReactionsNamespace;
  /** Metadata for the connected Forem instance. */
  readonly instance: InstanceNamespace;
  /** Sub-communities on the instance. */
  readonly subforems: SubforemsNamespace;
  /** App, cache, and database liveness probes. */
  readonly healthChecks: HealthChecksNamespace;
  /** Trends and their articles. */
  readonly trends: TrendsNamespace;
  /** Surveys and their poll results. */
  readonly surveys: SurveysNamespace;
  /** Concepts and their articles. */
  readonly concepts: ConceptsNamespace;
  /** Agent sessions, plus the undocumented presign and raw-url helpers. */
  readonly agentSessions: AgentSessionsNamespace;
  /** Badge definitions. Mutations require admin credentials. */
  readonly badges: BadgesNamespace;
  /** Badges awarded to users. Awarding requires admin credentials. */
  readonly badgeAchievements: BadgeAchievementsNamespace;
  /** Billboards (display ads). Requires admin credentials. */
  readonly billboards: BillboardsNamespace;
  /** Static instance pages. Mutations require admin credentials. */
  readonly pages: PagesNamespace;
  /** Audience segments and their membership. Requires admin credentials. */
  readonly segments: SegmentsNamespace;
  /** Recommended-articles lists. Mutations require admin credentials. */
  readonly recommendedArticlesLists: RecommendedArticlesListsNamespace;
  /** Analytics for your own content. */
  readonly analytics: AnalyticsNamespace;
  /** Update the status of an abuse/feedback report. Requires super_moderator credentials. */
  readonly feedbackMessages: FeedbackMessagesNamespace;
  /** Admin-only resources: user administration, concepts, and request redirects. Requires admin credentials. */
  readonly admin: {
    users: AdminUsersNamespace;
    concepts: AdminConceptsNamespace;
    requestRedirects: AdminRequestRedirectsNamespace;
  };

  constructor(options: ClientOptions = {}) {
    this.config = resolveConfig(options);
    const rf: RequestFn = (method, path, opts) => request(this.config, method, path, opts);

    this.articles = bindOps<ArticlesNamespace>(rf, articlesTable);
    this.comments = bindOps<CommentsNamespace>(rf, commentsTable);
    this.users = bindOps<UsersNamespace>(rf, usersTable);
    this.organizations = bindOps<OrganizationsNamespace>(rf, organizationsTable);
    this.followers = bindOps<FollowersNamespace>(rf, followersTable);
    this.follows = bindOps<FollowsNamespace>(rf, followsTable);
    this.tags = bindOps<TagsNamespace>(rf, tagsTable);
    this.readinglist = bindOps<ReadinglistNamespace>(rf, readinglistTable);
    this.podcastEpisodes = bindOps<PodcastEpisodesNamespace>(rf, podcastEpisodesTable);
    this.videos = bindOps<VideosNamespace>(rf, videosTable);
    this.profileImages = bindOps<ProfileImagesNamespace>(rf, profileImagesTable);
    this.reactions = bindOps<ReactionsNamespace>(rf, reactionsTable);
    this.instance = bindOps<InstanceNamespace>(rf, instanceTable);
    this.subforems = bindOps<SubforemsNamespace>(rf, subforemsTable);
    this.healthChecks = bindOps<HealthChecksNamespace>(rf, healthChecksTable);
    this.trends = bindOps<TrendsNamespace>(rf, trendsTable);
    this.surveys = bindOps<SurveysNamespace>(rf, surveysTable);
    this.concepts = bindOps<ConceptsNamespace>(rf, conceptsTable);
    this.agentSessions = bindOps<AgentSessionsNamespace>(rf, agentSessionsTable);
    this.badges = bindOps<BadgesNamespace>(rf, badgesTable);
    this.badgeAchievements = bindOps<BadgeAchievementsNamespace>(rf, badgeAchievementsTable);
    this.billboards = bindOps<BillboardsNamespace>(rf, billboardsTable);
    this.pages = bindOps<PagesNamespace>(rf, pagesTable);
    this.segments = bindOps<SegmentsNamespace>(rf, segmentsTable);
    this.recommendedArticlesLists = bindOps<RecommendedArticlesListsNamespace>(
      rf,
      recommendedArticlesListsTable,
    );
    this.analytics = bindOps<AnalyticsNamespace>(rf, analyticsTable);
    this.feedbackMessages = bindOps<FeedbackMessagesNamespace>(rf, feedbackMessagesTable);
    this.admin = {
      users: bindOps<AdminUsersNamespace>(rf, adminUsersTable),
      concepts: bindOps<AdminConceptsNamespace>(rf, adminConceptsTable),
      requestRedirects: bindOps<AdminRequestRedirectsNamespace>(rf, adminRequestRedirectsTable),
    };
  }

  /** Escape hatch and internal transport: namespace methods route through here. */
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    return request<T>(this.config, method, path, opts);
  }
}
