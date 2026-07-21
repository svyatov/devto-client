import { describe, expect, it, vi } from "bun:test";
import { paginate } from "../src/pagination.ts";

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
};

/** fetchPage stub yielding the given pages in order, then empty pages forever. */
const pages =
  <T>(...batches: T[][]) =>
  async (page: number): Promise<T[]> =>
    batches[page - 1] ?? [];

describe("paginate", () => {
  it("yields all items across pages and stops at the first empty page (AE3)", async () => {
    const fetchPage = vi.fn(pages([1, 2], [3, 4], [5, 6]));
    await expect(collect(paginate(fetchPage))).resolves.toEqual([1, 2, 3, 4, 5, 6]);
    expect(fetchPage).toHaveBeenCalledTimes(4); // 3 full pages + the terminating empty one
  });

  it("yields nothing for an empty first page", async () => {
    await expect(collect(paginate(pages()))).resolves.toEqual([]);
  });

  it("does not treat a short page as terminal: servers cap per_page", async () => {
    // requested 100 per page; server caps at 2, so every page is "short"
    const fetchPage = pages([1, 2], [3], [4, 5]);
    await expect(collect(paginate(fetchPage, { perPage: 100 }))).resolves.toEqual([1, 2, 3, 4, 5]);
  });

  it("forwards page and per_page to the fetcher", async () => {
    const fetchPage = vi.fn(pages(["a"]));
    await collect(paginate(fetchPage, { perPage: 42 }));
    expect(fetchPage).toHaveBeenNthCalledWith(1, 1, 42);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2, 42);
  });

  it("propagates a thrown error to the consumer", async () => {
    const fetchPage = async (page: number): Promise<number[]> => {
      if (page === 2) throw new Error("boom");
      return [1];
    };
    await expect(collect(paginate(fetchPage))).rejects.toThrow("boom");
  });

  it("stops fetching when the consumer breaks early", async () => {
    const fetchPage = vi.fn(pages([1, 2], [3, 4]));
    for await (const item of paginate(fetchPage)) {
      if (item === 1) break;
    }
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
