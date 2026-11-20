// How often a caller of `wait` is given news.
//
// Once a job logs something new, `wait` keeps collecting for a settle window and then
// returns. Each return costs the forwarding subagent one model call, and every call
// re-reads all it has seen so far. So the window grows with the job's age:
// quick updates while a job is young, when most jobs end, and fewer on a long run.

/** With nothing new to tell, `wait` returns after this long anyway. */
export const DEFAULT_MAX_WAIT_SEC = 90;

const SETTLE_WINDOWS = [
  { untilAgeMs: 60_000, windowMs: 6_000 },
  { untilAgeMs: 5 * 60_000, windowMs: 15_000 },
  { untilAgeMs: Infinity, windowMs: 60_000 }
];

/** The settle window for a job that has been running for `ageMs`. */
export function settleWindowMs(ageMs) {
  return SETTLE_WINDOWS.find((step) => ageMs < step.untilAgeMs).windowMs;
}
