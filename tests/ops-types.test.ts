import { expect, it } from "vitest";
import type {
  AdminConceptsNamespace,
  AdminRequestRedirectsNamespace,
  AdminUsersNamespace,
  AgentSessionsNamespace,
  AnalyticsNamespace,
  ArticlesNamespace,
  BadgeAchievementsNamespace,
  BadgesNamespace,
  BillboardsNamespace,
  CommentsNamespace,
  ConceptsNamespace,
  FeedbackMessagesNamespace,
  FollowersNamespace,
  FollowsNamespace,
  HealthChecksNamespace,
  InstanceNamespace,
  OrganizationsNamespace,
  PagesNamespace,
  PodcastEpisodesNamespace,
  ProfileImagesNamespace,
  ReactionsNamespace,
  ReadinglistNamespace,
  RecommendedArticlesListsNamespace,
  SegmentsNamespace,
  SubforemsNamespace,
  SurveysNamespace,
  TagsNamespace,
  TrendsNamespace,
  UsersNamespace,
  VideosNamespace,
} from "../src/generated/signatures.ts";
import { DevToClient } from "../src/index.ts";
import type {
  CallOptions,
  CallResult,
  MutuallyAssignable,
  NamespaceOf,
  NoQueryAndBody,
  NoQueryAndBodyOp,
  OpEntry,
} from "../src/ops.ts";
import type { adminConceptsTable } from "../src/resources/admin-concepts.ts";
import type { adminRequestRedirectsTable } from "../src/resources/admin-request-redirects.ts";
import type { adminUsersTable } from "../src/resources/admin-users.ts";
import type { agentSessionsTable } from "../src/resources/agent-sessions.ts";
import type { analyticsTable } from "../src/resources/analytics.ts";
import type { articlesTable } from "../src/resources/articles.ts";
import type { badgeAchievementsTable } from "../src/resources/badge-achievements.ts";
import type { badgesTable } from "../src/resources/badges.ts";
import type { billboardsTable } from "../src/resources/billboards.ts";
import type { commentsTable } from "../src/resources/comments.ts";
import type { conceptsTable } from "../src/resources/concepts.ts";
import type { feedbackMessagesTable } from "../src/resources/feedback-messages.ts";
import type { followersTable } from "../src/resources/followers.ts";
import type { followsTable } from "../src/resources/follows.ts";
import type { healthChecksTable } from "../src/resources/health-checks.ts";
import type { instanceTable } from "../src/resources/instance.ts";
import type { organizationsTable } from "../src/resources/organizations.ts";
import type { pagesTable } from "../src/resources/pages.ts";
import type { podcastEpisodesTable } from "../src/resources/podcast-episodes.ts";
import type { profileImagesTable } from "../src/resources/profile-images.ts";
import type { reactionsTable } from "../src/resources/reactions.ts";
import type { readinglistTable } from "../src/resources/readinglist.ts";
import type { recommendedArticlesListsTable } from "../src/resources/recommended-articles-lists.ts";
import type { segmentsTable } from "../src/resources/segments.ts";
import type { subforemsTable } from "../src/resources/subforems.ts";
import type { surveysTable } from "../src/resources/surveys.ts";
import type { tagsTable } from "../src/resources/tags.ts";
import type { trendsTable } from "../src/resources/trends.ts";
import type { usersTable } from "../src/resources/users.ts";
import type { videosTable } from "../src/resources/videos.ts";

/** Compile-time assertion helper — `Assert<false>` is a type error. */
type Assert<T extends true> = T;

// ---------------------------------------------------------------------------
// KTD4: bodyKey is constrained to the op's real single-key wrapper, required
// when the body is a wrapper and forbidden otherwise. A wrong, stale, or
// missing bodyKey is a compile error.
// ---------------------------------------------------------------------------
// AE2 (type half): the correct wrapper key compiles.
({ path: "/api/articles", verb: "post", bodyKey: "article" }) satisfies OpEntry;
// @ts-expect-error — misspelled wrapper key
({ path: "/api/articles", verb: "post", bodyKey: "artcle" }) satisfies OpEntry;
// @ts-expect-error — a wrapper op must declare its bodyKey (completeness)
({ path: "/api/articles", verb: "post" }) satisfies OpEntry;
// @ts-expect-error — a flat-body op must not declare a bodyKey
({ path: "/api/admin/users", verb: "post", bodyKey: "user" }) satisfies OpEntry;
// a genuinely flat-body op carries no bodyKey
({ path: "/api/admin/users", verb: "post" }) satisfies OpEntry;

// ---------------------------------------------------------------------------
// R8: no operation may declare both a query object and a body — the routing
// rule (body-else-query) depends on it. The real surface holds; the guard
// mechanism rejects a synthetic op that violates it.
// ---------------------------------------------------------------------------
type _r8Holds = Assert<NoQueryAndBodyOp>;
type SyntheticQueryAndBody = {
  parameters: { query: { x: string } };
  requestBody: { content: { "application/json": { y: number } } };
  responses: { 200: { content: { "application/json": { ok: true } } } };
};
// @ts-expect-error — an op with both query and body fails the guard
type _r8Rejects = Assert<NoQueryAndBody<SyntheticQueryAndBody>>;

// ---------------------------------------------------------------------------
// KTD2: each generated interface is mutually assignable to the spec-derived
// reference NamespaceOf<table>, so a generated signature cannot drift from the
// spec in parameter type or arity. Every resource table is pinned (not just a
// branch-representative sample), so the guarantee is universal across the surface.
// ---------------------------------------------------------------------------
type _pin_articles = Assert<
  MutuallyAssignable<ArticlesNamespace, NamespaceOf<typeof articlesTable>>
>;
type _pin_comments = Assert<
  MutuallyAssignable<CommentsNamespace, NamespaceOf<typeof commentsTable>>
>;
type _pin_users = Assert<MutuallyAssignable<UsersNamespace, NamespaceOf<typeof usersTable>>>;
type _pin_organizations = Assert<
  MutuallyAssignable<OrganizationsNamespace, NamespaceOf<typeof organizationsTable>>
>;
type _pin_followers = Assert<
  MutuallyAssignable<FollowersNamespace, NamespaceOf<typeof followersTable>>
>;
type _pin_follows = Assert<MutuallyAssignable<FollowsNamespace, NamespaceOf<typeof followsTable>>>;
type _pin_tags = Assert<MutuallyAssignable<TagsNamespace, NamespaceOf<typeof tagsTable>>>;
type _pin_readinglist = Assert<
  MutuallyAssignable<ReadinglistNamespace, NamespaceOf<typeof readinglistTable>>
>;
type _pin_podcastEpisodes = Assert<
  MutuallyAssignable<PodcastEpisodesNamespace, NamespaceOf<typeof podcastEpisodesTable>>
>;
type _pin_videos = Assert<MutuallyAssignable<VideosNamespace, NamespaceOf<typeof videosTable>>>;
type _pin_profileImages = Assert<
  MutuallyAssignable<ProfileImagesNamespace, NamespaceOf<typeof profileImagesTable>>
>;
type _pin_reactions = Assert<
  MutuallyAssignable<ReactionsNamespace, NamespaceOf<typeof reactionsTable>>
>;
type _pin_instance = Assert<
  MutuallyAssignable<InstanceNamespace, NamespaceOf<typeof instanceTable>>
>;
type _pin_subforems = Assert<
  MutuallyAssignable<SubforemsNamespace, NamespaceOf<typeof subforemsTable>>
>;
type _pin_healthChecks = Assert<
  MutuallyAssignable<HealthChecksNamespace, NamespaceOf<typeof healthChecksTable>>
>;
type _pin_trends = Assert<MutuallyAssignable<TrendsNamespace, NamespaceOf<typeof trendsTable>>>;
type _pin_surveys = Assert<MutuallyAssignable<SurveysNamespace, NamespaceOf<typeof surveysTable>>>;
type _pin_concepts = Assert<
  MutuallyAssignable<ConceptsNamespace, NamespaceOf<typeof conceptsTable>>
>;
type _pin_agentSessions = Assert<
  MutuallyAssignable<AgentSessionsNamespace, NamespaceOf<typeof agentSessionsTable>>
>;
type _pin_badges = Assert<MutuallyAssignable<BadgesNamespace, NamespaceOf<typeof badgesTable>>>;
type _pin_badgeAchievements = Assert<
  MutuallyAssignable<BadgeAchievementsNamespace, NamespaceOf<typeof badgeAchievementsTable>>
>;
type _pin_billboards = Assert<
  MutuallyAssignable<BillboardsNamespace, NamespaceOf<typeof billboardsTable>>
>;
type _pin_pages = Assert<MutuallyAssignable<PagesNamespace, NamespaceOf<typeof pagesTable>>>;
type _pin_segments = Assert<
  MutuallyAssignable<SegmentsNamespace, NamespaceOf<typeof segmentsTable>>
>;
type _pin_recommendedArticlesLists = Assert<
  MutuallyAssignable<
    RecommendedArticlesListsNamespace,
    NamespaceOf<typeof recommendedArticlesListsTable>
  >
>;
type _pin_analytics = Assert<
  MutuallyAssignable<AnalyticsNamespace, NamespaceOf<typeof analyticsTable>>
>;
type _pin_feedbackMessages = Assert<
  MutuallyAssignable<FeedbackMessagesNamespace, NamespaceOf<typeof feedbackMessagesTable>>
>;
type _pin_adminUsers = Assert<
  MutuallyAssignable<AdminUsersNamespace, NamespaceOf<typeof adminUsersTable>>
>;
type _pin_adminConcepts = Assert<
  MutuallyAssignable<AdminConceptsNamespace, NamespaceOf<typeof adminConceptsTable>>
>;
type _pin_adminRequestRedirects = Assert<
  MutuallyAssignable<AdminRequestRedirectsNamespace, NamespaceOf<typeof adminRequestRedirectsTable>>
>;

// The contract catches param-type drift in either direction (perturbing `get`).
type NarrowedGet = Omit<ArticlesNamespace, "get"> & {
  get: (id: string, opts?: CallOptions) => CallResult<"/api/articles/{id}", "get">;
};
// @ts-expect-error — id narrowed to string breaks mutual assignability
type _driftNarrow = Assert<MutuallyAssignable<NarrowedGet, NamespaceOf<typeof articlesTable>>>;
type WidenedGet = Omit<ArticlesNamespace, "get"> & {
  get: (id: number | string, opts?: CallOptions) => CallResult<"/api/articles/{id}", "get">;
};
// @ts-expect-error — id widened to number | string also breaks it
type _driftWiden = Assert<MutuallyAssignable<WidenedGet, NamespaceOf<typeof articlesTable>>>;

/**
 * Compile-time contract for the Call rule: positional path params, required
 * query params, and iterator page-rejection must hold at the type level.
 * Enforced by `tsc` (an unfired @ts-expect-error is itself an error); the
 * closure is never invoked, so no requests are made.
 */
const client = new DevToClient();

it("enforces the Call rule at compile time (AE3, AE4, AE6)", () => {
  const compileOnly = () => {
    // fully optional → zero-arg call allowed
    void client.articles.list();
    void client.comments.list();

    // AE3: required query params make the flat params object mandatory
    // @ts-expect-error toggle requires category/reactable_id/reactable_type
    void client.reactions.toggle();
    // @ts-expect-error the params object is required
    void client.reactions.toggle({});
    // @ts-expect-error reactable_type is missing
    void client.reactions.toggle({ category: "like", reactable_id: 1 });
    void client.reactions.toggle({ category: "like", reactable_id: 1, reactable_type: "Article" });
    // @ts-expect-error semantic search requires q
    void client.articles.semanticSearch();
    void client.articles.semanticSearch({ q: "cats" });

    // AE4: iterator variants inherit the requirement but never accept page
    // @ts-expect-error q is still required on the iterator
    void client.articles.semanticSearchAll();
    // @ts-expect-error page is driven by the iterator, not the caller
    void client.articles.semanticSearchAll({ q: "cats", page: 2 });
    void client.articles.semanticSearchAll({ q: "cats" });
    void client.articles.listAll();

    // AE6: positional path params — true names, arity enforced
    // @ts-expect-error id path param is required
    void client.articles.get();
    void client.articles.get(1);
    // @ts-expect-error getByPath needs both username and slug
    void client.articles.getByPath("jess");
    void client.articles.getByPath("jess", "some-post");
  };
  expect(compileOnly).toBeInstanceOf(Function);
});
