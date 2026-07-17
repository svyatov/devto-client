import { DevToApiError, type ErrorEnvelope } from "./errors.ts";

const ACCEPT_V1 = "application/vnd.forem.api-v1+json";
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
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
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
  fetch: typeof globalThis.fetch;
}

export function resolveConfig(options: ClientOptions): ResolvedConfig {
  const baseUrl = (options.baseUrl ?? "https://dev.to").replace(/\/+$/, "");
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
    fetch: options.fetch ?? globalThis.fetch,
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
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

  const headers = new Headers(opts.headers);
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
      await sleep(retryAfterMs ?? backoffDelay(attempt, retry), opts.signal);
      continue;
    }
    if (retriesLeft && res.status >= 500 && IDEMPOTENT.has(method)) {
      await sleep(backoffDelay(attempt, retry), opts.signal);
      continue;
    }
    throw await toApiError(res);
  }
}
