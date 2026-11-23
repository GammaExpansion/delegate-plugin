// A fallback for cancellation: both backends ask their agent to stop and then wait for
// it to say that it has. An agent that never answers must not keep the turn alive.

export const CANCEL_GRACE_MS = 10_000;

/**
 * Call `onExpired` once `signal` has been aborted for `ms`. Works whether the abort comes
 * later or has already happened, which a plain "abort" listener would miss.
 * @param {AbortSignal | undefined} signal
 * @param {number} ms
 * @param {() => void} onExpired
 * @returns {() => void} stop watching
 */
export function afterAbort(signal, ms, onExpired) {
  if (!signal) return () => {};
  let timer = null;
  const arm = () => {
    timer = setTimeout(onExpired, ms);
    timer.unref();
  };
  if (signal.aborted) arm();
  else signal.addEventListener("abort", arm, { once: true });
  return () => {
    signal.removeEventListener("abort", arm);
    if (timer) clearTimeout(timer);
  };
}
