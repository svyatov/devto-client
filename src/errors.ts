/** The `{ error, status }` envelope rendered by Forem's v1 API controllers. */
export interface ErrorEnvelope {
  error: string;
  /** Hand-rolled 400s (e.g. semantic_search) omit this. */
  status?: number;
}

/**
 * Every non-2xx response surfaces as this single error class: HTTP status,
 * the parsed `{ error, status }` envelope when the body is one, and the raw
 * body text otherwise (Rack::Attack's 429 is plain text).
 */
export class DevToApiError extends Error {
  override readonly name: string = "DevToApiError";
  readonly status: number;
  readonly body: ErrorEnvelope | undefined;
  readonly rawBody: string;

  constructor(status: number, body: ErrorEnvelope | undefined, rawBody: string) {
    super(
      body
        ? `${body.error} (HTTP ${status})`
        : rawBody
          ? `HTTP ${status}: ${rawBody}`
          : `HTTP ${status}`,
    );
    this.status = status;
    this.body = body;
    this.rawBody = rawBody;
  }
}
