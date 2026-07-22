/**
 * The `debug: true` printer, and the reference implementation of the event seam:
 * it reads nothing the seam does not hand every consumer (R11).
 *
 * Output goes to `console.error` rather than `process.stderr`, which reaches
 * stderr on Node and Bun and devtools in a browser with no `node:` import and no
 * runtime probe. The trade is that these lines interleave with the consumer's own
 * console output.
 */
import type { DevToEvent } from "./events.ts";

const PREFIX = "devto";

/**
 * Everything reaching a line-oriented log gets scrubbed, not only the free-text
 * `traceId`: a newline anywhere in a line forges a log entry, and the escape
 * hatch takes a caller-typed method and path too.
 *
 * C0 and DEL are the obvious half. The rest matter because a line is the
 * reader's definition, not ours: U+0085, U+2028 and U+2029 end a line in
 * Java, .NET and JS regex `.`, and the bidi overrides reorder a line whose
 * bytes never changed.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: scrubbing them is the point
const FORGEABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function scrub(text: string): string {
  return text.replaceAll(FORGEABLE, "?");
}

/** Path and query only: the host repeats on every line and the line is long enough. */
function where(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * A printer for `onEvent`. Renders no header name and no header value (R16), so
 * leaving it on cannot leak what the seam deliberately hands you raw.
 *
 * The line format is diagnostic output, not API: it may change in any release.
 */
export function createDebugPrinter(): (e: DevToEvent) => void {
  return (e: DevToEvent): void => {
    const id = e.traceId === undefined ? `#${e.callId}` : `#${e.callId} ${e.traceId}`;
    const at = `${e.method} ${where(e.url)}`;
    const tail = `${id} attempt ${e.attempt}`;
    let body: string;
    switch (e.kind) {
      case "request":
        body = `-> ${at} ${tail}`;
        break;
      case "response": {
        const paced = e.pacedMs > 0 ? ` paced ${e.pacedMs}ms` : "";
        const cached = e.fromCache ? " cached" : "";
        body = `<- ${e.status} ${at} ${e.durationMs}ms${paced}${cached} ${tail}`;
        break;
      }
      case "retry":
        body = `.. retry in ${e.waitMs}ms (${e.reason}) ${at} ${tail}`;
        break;
      case "failure":
        body = `xx ${describe(e.error)} ${at} ${e.durationMs}ms ${tail}`;
        break;
      default:
        // R15: the union is open, so a kind this build has never heard of is a
        // normal thing to receive, not a reason to throw inside a logger. The
        // base fields every member shares still render, only the body is opaque.
        body = `?? ${String((e as { kind?: unknown }).kind)} ${at} ${tail}`;
    }
    console.error(scrub(`${PREFIX} ${body}`));
  };
}
