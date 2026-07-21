import { DevToApiError, type ErrorEnvelope } from "./errors.ts";
import { VERSION } from "./version.ts";

const ACCEPT_V1 = "application/vnd.forem.api-v1+json";
const USER_AGENT = `devto-client/${VERSION}`;
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

/** Retry policy for transient failures: 429 responses (any method) and 5xx on idempotent methods. */
export interface RetryOptions {
  /** Total attempts including the first request. Default 3. */
  attempts?: number;
  /** Cap on any single wait; a Retry-After beyond it throws instead of sleeping. Default 30s. */
  maxDelayMs?: number;
  /** First backoff step for 5xx and unparseable Retry-After. Default 500ms. */
  baseDelayMs?: number;
}

/** Options for constructing a {@link DevToClient}. */
export interface ClientOptions {
  /** Forem API key. Optional — public endpoints work keyless. */
  apiKey?: string;
  /** Defaults to https://dev.to; set for self-hosted Forem instances. */
  baseUrl?: string;
  /** The api-key must never transit cleartext; opt in explicitly for local instances. */
  allowInsecureHttp?: boolean;
  /** `false` disables retries entirely. */
  retry?: RetryOptions | false;
  /**
   * Default headers merged into every request. Set a `user-agent` to identify
   * your app, for instance. Per-request `headers` override these; the versioned
   * Accept header and the api-key always win. Pass your Forem key via `apiKey`,
   * not here; a key set through `headers` skips the redirect-leak guard. Browsers
   * ignore a custom `user-agent`, so the setting only takes effect off the browser.
   */
  headers?: Record<string, string>;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests. Defaults to a timer-backed sleep a Retry-After can drive. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Per-request options for the low-level {@link DevToClient.request} escape hatch. */
export interface RequestOptions {
  /** Query parameters; `undefined` values are dropped, others are stringified. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Request body, JSON-serialized (sets `content-type: application/json` unless overridden). */
  body?: unknown;
  /** Abort signal; aborting rejects the call and cancels any pending retry backoff. */
  signal?: AbortSignal;
  /** Merged into the request; the versioned Accept header always wins. */
  headers?: Record<string, string>;
}

export interface ResolvedConfig {
  apiKey: string | undefined;
  baseUrl: string;
  retry: Required<RetryOptions> | null;
  headers: Record<string, string> | undefined;
  fetch: typeof globalThis.fetch;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

export function resolveConfig(options: ClientOptions): ResolvedConfig {
  // the lookbehind pins the match to the start of the trailing run; without it
  // `\/+$` restarts at every slash and goes quadratic on `"https://x" + "/".repeat(1e5) + "y"`
  const baseUrl = (options.baseUrl ?? "https://dev.to").replace(/(?<!\/)\/+$/, "");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`baseUrl must be http(s), got ${parsed.protocol}`);
  }
  if (parsed.protocol === "http:" && options.allowInsecureHttp !== true) {
    throw new Error(
      "baseUrl must be https — the api-key would transit cleartext. Set allowInsecureHttp: true to override.",
    );
  }
  return {
    apiKey: options.apiKey,
    baseUrl,
    retry:
      options.retry === false
        ? null
        : {
            attempts: options.retry?.attempts ?? 3,
            maxDelayMs: options.retry?.maxDelayMs ?? 30_000,
            baseDelayMs: options.retry?.baseDelayMs ?? 500,
          },
    headers: options.headers,
    fetch: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? sleep,
  };
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Integer-seconds Retry-After only; HTTP-dates and garbage fall back to the backoff schedule. */
function parseRetryAfter(header: string | null): number | null {
  return header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : null;
}

function backoffDelay(attempt: number, retry: Required<RetryOptions>): number {
  const exp = retry.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exp * (0.5 + Math.random() * 0.5), retry.maxDelayMs);
}

async function toApiError(res: Response): Promise<DevToApiError> {
  const rawBody = await res.text();
  let envelope: ErrorEnvelope | undefined;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as ErrorEnvelope).error === "string"
    ) {
      envelope = parsed as ErrorEnvelope;
    }
  } catch {
    // not JSON — rawBody carries it
  }
  return new DevToApiError(res.status, envelope, rawBody);
}

export async function request<T>(
  config: ResolvedConfig,
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  if (opts.signal?.aborted) throw abortReason(opts.signal);

  const url = new URL(config.baseUrl + path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers = new Headers({ ...config.headers, ...opts.headers });
  // weakest precedence, unlike accept and api-key below: a caller who names the
  // library in their own user-agent replaces ours rather than collecting both.
  // `has` rather than an object-spread default so `User-Agent` matches too.
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  headers.set("accept", ACCEPT_V1);
  if (config.apiKey !== undefined) headers.set("api-key", config.apiKey);

  const init: RequestInit = { method, headers };
  // fetch strips Authorization on cross-origin redirects but forwards custom
  // headers like api-key — refuse redirects outright rather than leak the key
  if (config.apiKey !== undefined) init.redirect = "error";
  if (opts.signal) init.signal = opts.signal;
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  const { retry } = config;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await config.fetch(url.toString(), init);
    } catch (cause) {
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      throw new Error(`${method} ${url} failed`, { cause });
    }

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text === "" ? undefined : JSON.parse(text)) as T;
    }

    const retriesLeft = retry !== null && attempt < retry.attempts;
    if (retriesLeft && res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      if (retryAfterMs !== null && retryAfterMs > retry.maxDelayMs) throw await toApiError(res);
      await config.sleep(retryAfterMs ?? backoffDelay(attempt, retry), opts.signal);
      continue;
    }
    if (retriesLeft && res.status >= 500 && IDEMPOTENT.has(method)) {
      await config.sleep(backoffDelay(attempt, retry), opts.signal);
      continue;
    }
    throw await toApiError(res);
  }
}
