import { expect, it } from "vitest";
import type { paths } from "../src/generated/types.ts";
import articles from "./fixtures/recorded/get_api-articles.json" with { type: "json" };
import articlesId from "./fixtures/recorded/get_api-articles-id.json" with { type: "json" };
import articlesLatest from "./fixtures/recorded/get_api-articles-latest.json" with { type: "json" };
import articlesMePublished from "./fixtures/recorded/get_api-articles-me-published.json" with {
  type: "json",
};
import articlesMeUnpublished from "./fixtures/recorded/get_api-articles-me-unpublished.json" with {
  type: "json",
};
import articlesSearch from "./fixtures/recorded/get_api-articles-search.json" with { type: "json" };
import articlesBySlug from "./fixtures/recorded/get_api-articles-username-slug.json" with {
  type: "json",
};
import comments from "./fixtures/recorded/get_api-comments.json" with { type: "json" };
import followersUsers from "./fixtures/recorded/get_api-followers-users.json" with { type: "json" };
import followsTags from "./fixtures/recorded/get_api-follows-tags.json" with { type: "json" };
import instance from "./fixtures/recorded/get_api-instance.json" with { type: "json" };
import orgArticles from "./fixtures/recorded/get_api-organizations-organization_id_or_username-articles.json" with {
  type: "json",
};
import orgUsers from "./fixtures/recorded/get_api-organizations-organization_id_or_username-users.json" with {
  type: "json",
};
import organization from "./fixtures/recorded/get_api-organizations-username.json" with {
  type: "json",
};
import pages from "./fixtures/recorded/get_api-pages.json" with { type: "json" };
import podcastEpisodes from "./fixtures/recorded/get_api-podcast_episodes.json" with {
  type: "json",
};
import readinglist from "./fixtures/recorded/get_api-readinglist.json" with { type: "json" };
import subforems from "./fixtures/recorded/get_api-subforems.json" with { type: "json" };
import tags from "./fixtures/recorded/get_api-tags.json" with { type: "json" };
import trends from "./fixtures/recorded/get_api-trends.json" with { type: "json" };
import user from "./fixtures/recorded/get_api-users-id.json" with { type: "json" };
import me from "./fixtures/recorded/get_api-users-me.json" with { type: "json" };
import videos from "./fixtures/recorded/get_api-videos.json" with { type: "json" };
import createdArticle from "./fixtures/recorded/post_api-articles.json" with { type: "json" };
import updatedArticle from "./fixtures/recorded/put_api-articles-id.json" with { type: "json" };

/**
 * R17, compile-time half: every recorded payload must be assignable to its
 * generated response type. The spec has no `required` lists so this can't see
 * a missing field (reality.test.ts covers that at runtime), but it does catch
 * wrong primitive types, mis-shaped nesting, and renamed fields with new
 * incompatible values.
 */

type ResponseAt<P extends keyof paths, V extends string, S extends number> =
  paths[P] extends Record<V, { responses: Record<S, { content: { "application/json": infer B } }> }>
    ? Widen<B>
    : never;

type Get200<P extends keyof paths> = ResponseAt<P, "get", 200>;

/**
 * JSON imports widen literal values to string/number, so a recorded
 * `visibility: "public"` types as `string` and can never satisfy the schema's
 * literal union. Widening the target the same way keeps the structural and
 * primitive checks while dropping only literal-exactness.
 */
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? Widen<U>[]
        : T extends object
          ? { [K in keyof T]: Widen<T[K]> }
          : T;

type Post201<P extends keyof paths> = ResponseAt<P, "post", 201>;
type Put200<P extends keyof paths> = ResponseAt<P, "put", 200>;

it("recorded payloads satisfy the generated response types", () => {
  const checks: [string, unknown][] = [
    ["/api/articles", articles.payload satisfies Get200<"/api/articles">],
    [
      "/api/articles/me/published",
      articlesMePublished.payload satisfies Get200<"/api/articles/me/published">,
    ],
    [
      "/api/articles/me/unpublished",
      articlesMeUnpublished.payload satisfies Get200<"/api/articles/me/unpublished">,
    ],
    ["POST /api/articles", createdArticle.payload satisfies Post201<"/api/articles">],
    ["PUT /api/articles/{id}", updatedArticle.payload satisfies Put200<"/api/articles/{id}">],
    ["/api/followers/users", followersUsers.payload satisfies Get200<"/api/followers/users">],
    ["/api/follows/tags", followsTags.payload satisfies Get200<"/api/follows/tags">],
    ["/api/readinglist", readinglist.payload satisfies Get200<"/api/readinglist">],
    ["/api/users/me", me.payload satisfies Get200<"/api/users/me">],
    ["/api/articles/latest", articlesLatest.payload satisfies Get200<"/api/articles/latest">],
    ["/api/articles/search", articlesSearch.payload satisfies Get200<"/api/articles/search">],
    ["/api/articles/{id}", articlesId.payload satisfies Get200<"/api/articles/{id}">],
    [
      "/api/articles/{username}/{slug}",
      articlesBySlug.payload satisfies Get200<"/api/articles/{username}/{slug}">,
    ],
    ["/api/comments", comments.payload satisfies Get200<"/api/comments">],
    ["/api/instance", instance.payload satisfies Get200<"/api/instance">],
    [
      "/api/organizations/{organization_id_or_username}/articles",
      orgArticles.payload satisfies Get200<"/api/organizations/{organization_id_or_username}/articles">,
    ],
    [
      "/api/organizations/{organization_id_or_username}/users",
      orgUsers.payload satisfies Get200<"/api/organizations/{organization_id_or_username}/users">,
    ],
    [
      "/api/organizations/{username}",
      organization.payload satisfies Get200<"/api/organizations/{username}">,
    ],
    ["/api/pages", pages.payload satisfies Get200<"/api/pages">],
    ["/api/podcast_episodes", podcastEpisodes.payload satisfies Get200<"/api/podcast_episodes">],
    ["/api/subforems", subforems.payload satisfies Get200<"/api/subforems">],
    ["/api/tags", tags.payload satisfies Get200<"/api/tags">],
    ["/api/trends", trends.payload satisfies Get200<"/api/trends">],
    ["/api/users/{id}", user.payload satisfies Get200<"/api/users/{id}">],
    ["/api/videos", videos.payload satisfies Get200<"/api/videos">],
  ];
  expect(checks).toHaveLength(25);
});
