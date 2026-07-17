/**
 * Declarative operation tables (KTD12): each resource method is a data entry
 * `{ path, verb, bodyKey?, paginated?, undocumented? }` keyed into the generated
 * `paths` types (`bodyKey` is required for single-key wrapper bodies, forbidden
 * otherwise), bound by the one builder below. The surface-inventory test diffs
 * these tables against the composed spec's operation list.
 */
import { opRouting } from "./generated/routing.ts";
import type { paths } from "./generated/types.ts";
import type { RequestOptions } from "./http.ts";
import { paginate } from "./pagination.ts";
import { pathParamNames } from "./path-template.ts";

type HttpVerb = "get" | "post" | "put" | "patch" | "delete";

type VerbsOf<P extends keyof paths> = {
  [V in HttpVerb]: paths[P][V] extends Record<string, unknown> ? V : never;
}[HttpVerb];

/**
 * A `bodyKey` slot tied to a single (path, verb): if the op's body is a
 * single-key object wrapper it MUST be declared and name that key (completeness
 * + correctness, KTD4); otherwise it is forbidden (`?: never`). A wrong, stale,
 * or missing `bodyKey` is therefore a compile error.
 */
type BodyKeySlot<P extends keyof paths, V extends keyof paths[P]> = [
  WrapperKeyOf<NonNullable<BodyOf<OpAt<P, V>>>>,
] extends [never]
  ? { bodyKey?: never }
  : { bodyKey: WrapperKeyOf<NonNullable<BodyOf<OpAt<P, V>>>> };

/**
 * An entry must name a real path and a verb that path actually documents (KTD10),
 * and — distributed per verb — carry the `bodyKey` its body shape demands (KTD4).
 */
export type OpEntry = {
  [P in keyof paths]: {
    [V in VerbsOf<P>]: {
      path: P;
      verb: V;
      /** list endpoint driven by page/per_page — gets an iterator variant */
      paginated?: true;
      /** verified in Forem routes but absent from upstream docs (KTD11) */
      undocumented?: true;
    } & BodyKeySlot<P, V>;
  }[VerbsOf<P>];
}[keyof paths];

export type OpTable = Record<string, OpEntry>;

type JsonOf<R> = R extends { content: { "application/json": infer B } } ? B : undefined;
type SuccessOf<O> = O extends { responses: infer R }
  ?
      | (200 extends keyof R ? JsonOf<R[200]> : never)
      | (201 extends keyof R ? JsonOf<R[201]> : never)
      | (204 extends keyof R ? undefined : never)
  : never;

type QueryOf<O> = O extends { parameters: { query?: infer Q } }
  ? Exclude<Q, undefined> extends Record<string, unknown>
    ? Exclude<Q, undefined>
    : never
  : never;
// A no-body op is generated as `requestBody?: never`; guard the optional branch
// against that, or it spuriously infers `unknown` and reads as a body (breaking R8).
type BodyOf<O> = O extends { requestBody: { content: { "application/json": infer B } } }
  ? B
  : O extends { requestBody?: infer RB }
    ? [RB] extends [never]
      ? never
      : NonNullable<RB> extends { content: { "application/json": infer B } }
        ? B | undefined
        : never
    : never;

type ItemOf<O> = SuccessOf<O> extends readonly (infer T)[] ? T : never;
type IterQueryOf<O> = [QueryOf<O>] extends [never] ? never : Omit<QueryOf<O>, "page">;

// ---------------------------------------------------------------------------
// Call rule (ergonomic surface). Positional required path params in URL order,
// then one flat params object (query OR unwrapped body — never both, R8), then
// a trailing options bag. The helpers below type each slot; the generator
// (`scripts/generate-signatures.ts`) supplies the parameter names and arity in
// `src/generated/signatures.ts`.
// ---------------------------------------------------------------------------

/** The `paths`-indexed operation object for a (path, verb) pair. */
export type OpAt<P extends keyof paths, V extends keyof paths[P]> = paths[P][V];

/** Trailing per-call options — transport concerns kept out of the params object. */
export type CallOptions = { signal?: AbortSignal };

export type CallResult<P extends keyof paths, V extends keyof paths[P]> = Promise<
  SuccessOf<OpAt<P, V>>
>;
export type IterResult<P extends keyof paths, V extends keyof paths[P]> = AsyncGenerator<
  ItemOf<OpAt<P, V>>,
  void,
  undefined
>;

/** Flat query params for an op (the generator emits this for query-routed ops). */
export type CallQuery<P extends keyof paths, V extends keyof paths[P]> = QueryOf<OpAt<P, V>>;
/** Flat body for a non-wrapper body op. */
export type CallBody<P extends keyof paths, V extends keyof paths[P]> = NonNullable<
  BodyOf<OpAt<P, V>>
>;
/** Unwrapped inner fields of a single-key wrapper body (R3), keyed by `bodyKey`. */
export type CallBodyInner<
  P extends keyof paths,
  V extends keyof paths[P],
  K extends string,
> = NonNullable<BodyOf<OpAt<P, V>>>[K & keyof NonNullable<BodyOf<OpAt<P, V>>>];
/** Flat iterator query for an op — same rule, minus the iterator-driven `page`. */
export type IterQuery<P extends keyof paths, V extends keyof paths[P]> = IterQueryOf<OpAt<P, V>>;

// -- Structural helpers feeding BodyKeySlot's wrapper-key detection (KTD4). --

type IsUnion<T, C = T> = T extends unknown ? ([C] extends [T] ? false : true) : never;
type IsSingle<T> = [T] extends [never] ? false : IsUnion<T> extends true ? false : true;

/** Keys of `T` whose (non-null) value is a plain object — not an array, not a primitive. */
type ObjectKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends readonly unknown[]
    ? never
    : NonNullable<T[K]> extends Record<string, unknown>
      ? K
      : never;
}[keyof T];

/** The wrapper key of a single-key object-valued body, or `never` if it isn't one. */
export type WrapperKeyOf<B> = [keyof B] extends [ObjectKeys<B>]
  ? IsSingle<keyof B> extends true
    ? keyof B & string
    : never
  : never;

/** `true` iff op `O` does not declare both a query object and a request body (R8). */
export type NoQueryAndBody<O> = [QueryOf<O>] extends [never]
  ? true
  : [BodyOf<O>] extends [never]
    ? true
    : false;

/** `true` iff NO operation in `paths` declares both a query object and a body (R8). */
export type NoQueryAndBodyOp = [
  {
    [P in keyof paths]: {
      [V in VerbsOf<P>]: NoQueryAndBody<OpAt<P, V>> extends true
        ? never
        : `${P & string} ${V & string}`;
    }[VerbsOf<P>];
  }[keyof paths],
] extends [never]
  ? true
  : false;

export type RequestFn = <R>(method: string, path: string, opts?: RequestOptions) => Promise<R>;

function fillPath(template: string, params: Record<string, string | number>): string {
  return template.replaceAll(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing path param "${name}" for ${template}`);
    return encodeURIComponent(String(value));
  });
}

/**
 * Binds a table to the Call rule (KTD3/KTD4): positional path values fill the
 * template in URL order, one flat params object routes to body or query by the
 * op's kind (`opRouting`) — wrapped under `bodyKey` when the body is a single-key
 * wrapper — and a trailing `opts.signal` reaches transport. Ops with no query or
 * body take no params object, so their `opts` follows the positional args.
 */
export function bindOps<N>(rf: RequestFn, table: OpTable): N {
  const ns: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(table)) {
    const pathNames = pathParamNames(entry.path);
    const route = opRouting[`${entry.verb} ${entry.path}`];
    const { bodyKey } = entry;
    const method = entry.verb.toUpperCase();

    const send = (
      pathValues: unknown[],
      params: unknown,
      opts: CallOptions | undefined,
    ): Promise<unknown> => {
      const pathParams: Record<string, string | number> = {};
      pathNames.forEach((n, i) => {
        pathParams[n] = pathValues[i] as string | number;
      });
      const reqOpts: RequestOptions = {};
      if (params !== undefined) {
        if (route === "body") reqOpts.body = bodyKey ? { [bodyKey]: params } : params;
        else reqOpts.query = params as Record<string, string | number | boolean | undefined>;
      }
      if (opts?.signal) reqOpts.signal = opts.signal;
      return rf(method, fillPath(entry.path, pathParams), reqOpts);
    };

    // async so a missing path param rejects instead of throwing synchronously (R7)
    ns[name] = async (...args: unknown[]) => {
      const pathValues = args.slice(0, pathNames.length);
      const params = route === undefined ? undefined : args[pathNames.length];
      const opts = args[pathNames.length + (route === undefined ? 0 : 1)] as
        | CallOptions
        | undefined;
      return send(pathValues, params, opts);
    };

    if (entry.paginated) {
      if (`${name}All` in table) {
        throw new Error(`table key "${name}All" collides with the iterator variant of "${name}"`);
      }
      ns[`${name}All`] = (...args: unknown[]) => {
        const pathValues = args.slice(0, pathNames.length);
        const params = (args[pathNames.length] ?? {}) as Record<string, unknown>;
        const opts = args[pathNames.length + 1] as CallOptions | undefined;
        return paginate(
          (page, perPage) =>
            send(pathValues, { ...params, page, per_page: perPage }, opts) as Promise<unknown[]>,
          typeof params.per_page === "number" ? { perPage: params.per_page } : {},
        );
      };
    }
  }
  return ns as N;
}
