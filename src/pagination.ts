/**
 * Iterates a `page`/`per_page` endpoint. Upstream sends no pagination
 * metadata, and servers may cap `per_page` below the requested value
 * (org users cap at 100, instances configure their own max), so a short
 * page can be a full page in disguise. Termination is an empty page only —
 * one extra request per iteration, always correct.
 */
export async function* paginate<T>(
  fetchPage: (page: number, perPage: number) => Promise<T[]>,
  options: { perPage?: number } = {},
): AsyncGenerator<T, void, undefined> {
  const perPage = options.perPage ?? 30;
  for (let page = 1; ; page++) {
    const items = await fetchPage(page, perPage);
    if (items.length === 0) return;
    yield* items;
  }
}
