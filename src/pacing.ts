import { DevToTimeoutError } from "./errors.ts";
import { sleep as defaultSleep } from "./timing.ts";

/**
 * Which of Forem's two budgets a request draws on. Rack::Attack counts GETs and
 * writes separately, so a burst of writes never starves reads and vice versa.
 */
export type PaceKind = "read" | "write";

export interface PacerOptions {
  /**
   * Reads per second. Default 3, matching Forem's `api_throttle` (per IP) and
   * `api_key_throttle` (per api-key), which enforce the same figure on both axes.
   */
  readsPerSecond?: number;
  /** Writes per second. Default 1, matching `api_write_throttle` / `api_write_key_throttle`. */
  writesPerSecond?: number;
  /**
   * Injectable for tests, the same seam as `ClientOptions.sleep`. A pacer the
   * client builds for itself inherits the client's sleep instead; only an
   * explicitly constructed one needs its own, because it can serve two clients
   * that injected different sleeps.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface Pacer {
  /**
   * Holds until a slot on the `kind` budget is free. Throws `DevToTimeoutError`
   * rather than sleeping when the slot lands past `deadlineAt`, and rejects with
   * the caller's abort reason if `signal` fires during the hold.
   */
  acquire(
    kind: PaceKind,
    opts: { deadlineAt: number; signal: AbortSignal | undefined },
  ): Promise<void>;
}

/**
 * A continuously-refilling token bucket with capacity equal to the per-second
 * allowance, so a script that stays inside the budget never waits at all.
 *
 * Tokens go negative on purpose: that is what queues concurrent callers behind
 * each other instead of letting them all compute the same wait and fire together.
 *
 * ponytail: the guarantee is at most `capacity + rate` requests in any one-second
 * window, which is not the same shape as Forem's fixed-window counter — a burst
 * straddling a window boundary can still draw a 429. Accepted per KTD3; the retry
 * path absorbs the ones that land. Tighten by lowering the rate, not by rewriting
 * this into a window counter, which would need the server's clock.
 */
class Bucket {
  private readonly rate: number;
  private tokens: number;
  private last = Date.now();

  constructor(rate: number) {
    this.rate = rate;
    this.tokens = rate;
  }

  /** Reserves a slot and returns how long to wait before using it. */
  reserve(): number {
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    const wait = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000);
    this.tokens -= 1;
    return wait;
  }

  /** Hands a reserved slot back when the call decided not to take its wait. */
  release(): void {
    this.tokens += 1;
  }
}

/**
 * Builds a pacer. Pass the same one to two clients and they share a budget;
 * give them separate ones and they hold independent budgets.
 *
 * Note that dev.to throttles per IP as well as per key, so two clients on one
 * machine share a server-side budget whether or not they share a pacer —
 * independent pacers under-protect rather than merely over-pace.
 */
export function createPacer(options: PacerOptions = {}): Pacer {
  const read = new Bucket(options.readsPerSecond ?? 3);
  const write = new Bucket(options.writesPerSecond ?? 1);
  // the shared sleep, not a bare setTimeout: a hold has to stay interruptible
  // for a pacer built by hand, exactly as it is for one the client builds
  const sleep = options.sleep ?? defaultSleep;

  return {
    async acquire(kind, { deadlineAt, signal }) {
      const bucket = kind === "write" ? write : read;
      const wait = bucket.reserve();
      if (wait === 0) return;
      if (Date.now() + wait > deadlineAt) {
        bucket.release();
        throw new DevToTimeoutError(
          `pacing would hold this ${kind} for ${wait}ms, past its deadline`,
          wait,
        );
      }
      await sleep(wait, signal);
    },
  };
}
