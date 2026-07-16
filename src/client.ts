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

export class DevToClient {
  private readonly config: ResolvedConfig;

  readonly articles: ArticlesNamespace;
  readonly comments: CommentsNamespace;
  readonly users: UsersNamespace;
  readonly organizations: OrganizationsNamespace;
  readonly followers: FollowersNamespace;
  readonly follows: FollowsNamespace;
  readonly tags: TagsNamespace;
  readonly readinglist: ReadinglistNamespace;
  readonly podcastEpisodes: PodcastEpisodesNamespace;
  readonly videos: VideosNamespace;
  readonly profileImages: ProfileImagesNamespace;
  readonly reactions: ReactionsNamespace;
  readonly instance: InstanceNamespace;
  readonly subforems: SubforemsNamespace;
  readonly healthChecks: HealthChecksNamespace;
  readonly trends: TrendsNamespace;
  readonly surveys: SurveysNamespace;
  readonly concepts: ConceptsNamespace;
  readonly agentSessions: AgentSessionsNamespace;
  readonly badges: BadgesNamespace;
  readonly badgeAchievements: BadgeAchievementsNamespace;
  readonly billboards: BillboardsNamespace;
  readonly pages: PagesNamespace;
  readonly segments: SegmentsNamespace;
  readonly recommendedArticlesLists: RecommendedArticlesListsNamespace;
  readonly analytics: AnalyticsNamespace;
  readonly feedbackMessages: FeedbackMessagesNamespace;
  readonly admin: {
    users: AdminUsersNamespace;
    concepts: AdminConceptsNamespace;
    requestRedirects: AdminRequestRedirectsNamespace;
  };

  constructor(options: ClientOptions = {}) {
    this.config = resolveConfig(options);
    const rf: RequestFn = (method, path, opts) => request(this.config, method, path, opts);

    this.articles = bindOps(rf, articlesTable);
    this.comments = bindOps(rf, commentsTable);
    this.users = bindOps(rf, usersTable);
    this.organizations = bindOps(rf, organizationsTable);
    this.followers = bindOps(rf, followersTable);
    this.follows = bindOps(rf, followsTable);
    this.tags = bindOps(rf, tagsTable);
    this.readinglist = bindOps(rf, readinglistTable);
    this.podcastEpisodes = bindOps(rf, podcastEpisodesTable);
    this.videos = bindOps(rf, videosTable);
    this.profileImages = bindOps(rf, profileImagesTable);
    this.reactions = bindOps(rf, reactionsTable);
    this.instance = bindOps(rf, instanceTable);
    this.subforems = bindOps(rf, subforemsTable);
    this.healthChecks = bindOps(rf, healthChecksTable);
    this.trends = bindOps(rf, trendsTable);
    this.surveys = bindOps(rf, surveysTable);
    this.concepts = bindOps(rf, conceptsTable);
    this.agentSessions = bindOps(rf, agentSessionsTable);
    this.badges = bindOps(rf, badgesTable);
    this.badgeAchievements = bindOps(rf, badgeAchievementsTable);
    this.billboards = bindOps(rf, billboardsTable);
    this.pages = bindOps(rf, pagesTable);
    this.segments = bindOps(rf, segmentsTable);
    this.recommendedArticlesLists = bindOps(rf, recommendedArticlesListsTable);
    this.analytics = bindOps(rf, analyticsTable);
    this.feedbackMessages = bindOps(rf, feedbackMessagesTable);
    this.admin = {
      users: bindOps(rf, adminUsersTable),
      concepts: bindOps(rf, adminConceptsTable),
      requestRedirects: bindOps(rf, adminRequestRedirectsTable),
    };
  }

  /** Escape hatch and internal transport — namespace methods route through here. */
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    return request<T>(this.config, method, path, opts);
  }
}
