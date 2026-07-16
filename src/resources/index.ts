import type { OpTable } from "../ops.ts";
import { adminConceptsTable } from "./admin-concepts.ts";
import { adminRequestRedirectsTable } from "./admin-request-redirects.ts";
import { adminUsersTable } from "./admin-users.ts";
import { agentSessionsTable } from "./agent-sessions.ts";
import { analyticsTable } from "./analytics.ts";
import { articlesTable } from "./articles.ts";
import { badgeAchievementsTable } from "./badge-achievements.ts";
import { badgesTable } from "./badges.ts";
import { billboardsTable } from "./billboards.ts";
import { commentsTable } from "./comments.ts";
import { conceptsTable } from "./concepts.ts";
import { feedbackMessagesTable } from "./feedback-messages.ts";
import { followersTable } from "./followers.ts";
import { followsTable } from "./follows.ts";
import { healthChecksTable } from "./health-checks.ts";
import { instanceTable } from "./instance.ts";
import { organizationsTable } from "./organizations.ts";
import { pagesTable } from "./pages.ts";
import { podcastEpisodesTable } from "./podcast-episodes.ts";
import { profileImagesTable } from "./profile-images.ts";
import { reactionsTable } from "./reactions.ts";
import { readinglistTable } from "./readinglist.ts";
import { recommendedArticlesListsTable } from "./recommended-articles-lists.ts";
import { segmentsTable } from "./segments.ts";
import { subforemsTable } from "./subforems.ts";
import { surveysTable } from "./surveys.ts";
import { tagsTable } from "./tags.ts";
import { trendsTable } from "./trends.ts";
import { usersTable } from "./users.ts";
import { videosTable } from "./videos.ts";

/** Every operation table — the surface-inventory test diffs this against the composed spec. */
export const allTables: Record<string, OpTable> = {
  articles: articlesTable,
  comments: commentsTable,
  users: usersTable,
  organizations: organizationsTable,
  followers: followersTable,
  follows: followsTable,
  tags: tagsTable,
  readinglist: readinglistTable,
  podcastEpisodes: podcastEpisodesTable,
  videos: videosTable,
  profileImages: profileImagesTable,
  reactions: reactionsTable,
  instance: instanceTable,
  subforems: subforemsTable,
  healthChecks: healthChecksTable,
  trends: trendsTable,
  surveys: surveysTable,
  concepts: conceptsTable,
  agentSessions: agentSessionsTable,
  badges: badgesTable,
  badgeAchievements: badgeAchievementsTable,
  billboards: billboardsTable,
  pages: pagesTable,
  segments: segmentsTable,
  recommendedArticlesLists: recommendedArticlesListsTable,
  analytics: analyticsTable,
  feedbackMessages: feedbackMessagesTable,
  "admin.users": adminUsersTable,
  "admin.concepts": adminConceptsTable,
  "admin.requestRedirects": adminRequestRedirectsTable,
};
