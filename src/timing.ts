/**
 * Abort-aware waiting, shared by the retry loop and the pacer. Its own module
 * because `http.ts` imports `pacing.ts`, so the pacer cannot import back.
 */

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
