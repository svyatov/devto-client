/**
 * Declarative operation tables (KTD12): each resource method is a data entry
 * `{ path, verb, paginated?, undocumented? }` keyed into the generated `paths`
 * types, bound by the one builder below. The surface-inventory test diffs
 * these tables against the composed spec's operation list.
 */
import type { paths } from "./generated/types.ts";
import type { RequestOptions } from "./http.ts";
import { paginate } from "./pagination.ts";

type HttpVerb = "get" | "post" | "put" | "patch" | "delete";

type VerbsOf<P extends keyof paths> = {
  [V in HttpVerb]: paths[P][V] extends Record<string, unknown> ? V : never;
}[HttpVerb];

/** An entry must name a real path and a verb that path actually documents (KTD10). */
export type OpEntry = {
  [P in keyof paths]: {
    path: P;
    verb: VerbsOf<P>;
    /** list endpoint driven by page/per_page — gets an iterator variant */
    paginated?: true;
    /** verified in Forem routes but absent from upstream docs (KTD11) */
    undocumented?: true;
  };
}[keyof paths];

export type OpTable = Record<string, OpEntry>;

type OpOf<E extends OpEntry> = paths[E["path"]][E["verb"] & keyof paths[E["path"]]];

type JsonOf<R> = R extends { content: { "application/json": infer B } } ? B : undefined;
type SuccessOf<O> = O extends { responses: infer R }
  ?
      | (200 extends keyof R ? JsonOf<R[200]> : never)
      | (201 extends keyof R ? JsonOf<R[201]> : never)
      | (204 extends keyof R ? undefined : never)
  : never;

type PathParamsOf<O> = O extends { parameters: { path: infer P } }
  ? P extends Record<string, unknown>
    ? P
    : never
  : never;
type QueryOf<O> = O extends { parameters: { query?: infer Q } }
  ? Exclude<Q, undefined> extends Record<string, unknown>
    ? Exclude<Q, undefined>
    : never
  : never;
type BodyOf<O> = O extends { requestBody: { content: { "application/json": infer B } } }
  ? B
  : O extends { requestBody?: { content: { "application/json": infer B } } }
    ? B | undefined
    : never;

type ArgsOf<O> = ([PathParamsOf<O>] extends [never] ? unknown : { path: PathParamsOf<O> }) &
  ([QueryOf<O>] extends [never] ? unknown : { query?: QueryOf<O> }) &
  ([BodyOf<O>] extends [never]
    ? unknown
    : undefined extends BodyOf<O>
      ? { body?: BodyOf<O> }
      : { body: BodyOf<O> }) & { signal?: AbortSignal };

/** No required keys → args object itself is optional. */
type Call<O> = [PathParamsOf<O>] extends [never]
  ? undefined extends BodyOf<O>
    ? (args?: ArgsOf<O>) => Promise<SuccessOf<O>>
    : [BodyOf<O>] extends [never]
      ? (args?: ArgsOf<O>) => Promise<SuccessOf<O>>
      : (args: ArgsOf<O>) => Promise<SuccessOf<O>>
  : (args: ArgsOf<O>) => Promise<SuccessOf<O>>;

type ItemOf<O> = SuccessOf<O> extends readonly (infer T)[] ? T : never;
type IterCall<O> = (
  args?: Omit<ArgsOf<O>, "query"> & { query?: Omit<QueryOf<O>, "page"> },
) => AsyncGenerator<ItemOf<O>, void, undefined>;

export type BoundOps<T extends OpTable> = { [K in keyof T]: Call<OpOf<T[K]>> } & {
  [K in keyof T as T[K]["paginated"] extends true ? `${K & string}All` : never]: IterCall<
    OpOf<T[K]>
  >;
};

export type RequestFn = <R>(method: string, path: string, opts?: RequestOptions) => Promise<R>;

interface RawArgs {
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

function fillPath(template: string, params: Record<string, string | number> = {}): string {
  return template.replaceAll(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing path param "${name}" for ${template}`);
    return encodeURIComponent(String(value));
  });
}

export function bindOps<T extends OpTable>(rf: RequestFn, table: T): BoundOps<T> {
  const ns: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(table)) {
    // async so a missing path param rejects instead of throwing synchronously
    const call = async (args: RawArgs = {}) => {
      const opts: RequestOptions = {};
      if (args.query) opts.query = args.query;
      if (args.body !== undefined) opts.body = args.body;
      if (args.signal) opts.signal = args.signal;
      return rf(entry.verb.toUpperCase(), fillPath(entry.path, args.path), opts);
    };
    ns[name] = call;
    if (entry.paginated) {
      if (`${name}All` in table) {
        throw new Error(`table key "${name}All" collides with the iterator variant of "${name}"`);
      }
      ns[`${name}All`] = (args: RawArgs = {}) =>
        paginate(
          (page, perPage) =>
            call({ ...args, query: { ...args.query, page, per_page: perPage } }) as Promise<
              unknown[]
            >,
          typeof args.query?.per_page === "number" ? { perPage: args.query.per_page } : {},
        );
    }
  }
  return ns as BoundOps<T>;
}
