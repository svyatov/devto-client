import { expect, it } from "bun:test";
import type { components, paths } from "../src/generated/types.ts";

/**
 * Compile-time half of sweep pass two's corrections. These fields were observed
 * on a local Forem at `ae359ff41b2a` and nothing else can corroborate them, so
 * unlike the recorded-fixture assertions next door there is no payload to check
 * against - the claim being pinned is that the generated type carries them, with
 * the primitives the run saw.
 *
 * They are pinned rather than trusted because the Overlay entries behind them
 * are hand-written, and a typo in one would otherwise surface as a silently
 * missing field in the public surface.
 */
type Billboard = components["schemas"]["Billboard"];

type ResponseAt<P extends keyof paths, V extends string, S extends number> =
  paths[P] extends Record<V, { responses: Record<S, { content: { "application/json": infer B } }> }>
    ? B
    : never;

it("the corrected Billboard carries every field the local run observed", () => {
  // one probe per correction: assigning a value of the declared primitive proves
  // both that the property exists and that it types as the run saw it
  const billboard: Pick<
    Billboard,
    | "browser_context"
    | "cached_tag_list"
    | "clicks_count"
    | "color"
    | "content_updated_at"
    | "counts_tabulated_at"
    | "created_at"
    | "custom_display_label"
    | "dismissal_sku"
    | "event_id"
    | "exclude_role_names"
    | "exclude_survey_completions"
    | "exclude_survey_ids"
    | "impressions_count"
    | "include_subforem_ids"
    | "minimized_body_markdown"
    | "minimized_processed_html"
    | "page_id"
    | "prefer_paired_with_billboard_id"
    | "preferred_article_ids"
    | "priority"
    | "processed_html"
    | "render_mode"
    | "requires_cookies"
    | "seconds_visible"
    | "special_behavior"
    | "success_rate"
    | "tags_array"
    | "target_role_names"
    | "template"
    | "updated_at"
    | "weight"
  > = {
    browser_context: "all_browsers",
    cached_tag_list: "",
    clicks_count: 0,
    color: null,
    content_updated_at: "2026-07-21T19:52:31.717Z",
    counts_tabulated_at: null,
    created_at: "2026-07-21T19:52:31.717Z",
    custom_display_label: null,
    dismissal_sku: null,
    event_id: null,
    exclude_role_names: [],
    exclude_survey_completions: false,
    exclude_survey_ids: "",
    impressions_count: 0,
    include_subforem_ids: [],
    minimized_body_markdown: null,
    minimized_processed_html: null,
    page_id: null,
    prefer_paired_with_billboard_id: null,
    preferred_article_ids: [],
    priority: false,
    processed_html: "<p>hello</p>",
    render_mode: "forem_markdown",
    requires_cookies: false,
    seconds_visible: 0,
    special_behavior: "nothing",
    success_rate: 0,
    tags_array: [],
    target_role_names: [],
    template: "authorship_box",
    updated_at: "2026-07-21T19:52:31.717Z",
    weight: 1,
  };
  expect(Object.keys(billboard)).toHaveLength(32);
});

it("every billboard operation resolves to that same corrected type", () => {
  // the two write responses were `unknown` until the run confirmed them: upstream
  // declared `{type: object, items: ...}`, where `items` is array-only and the
  // $ref never resolved
  const checks: [string, unknown][] = [
    ["GET /api/billboards", [] as Billboard[] satisfies ResponseAt<"/api/billboards", "get", 200>],
    [
      "GET /api/billboards/{id}",
      {} as Billboard satisfies ResponseAt<"/api/billboards/{id}", "get", 200>,
    ],
    ["POST /api/billboards", {} as Billboard satisfies ResponseAt<"/api/billboards", "post", 201>],
    [
      "PUT /api/billboards/{id}",
      {} as Billboard satisfies ResponseAt<"/api/billboards/{id}", "put", 200>,
    ],
  ];
  expect(checks).toHaveLength(4);
});
