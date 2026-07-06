/**
 * Date utilities for tool input handling.
 *
 * parseDate: validates that a string is a parseable date and returns epoch
 * ms. Throws with a useful field name on failure. Prevents the silent
 * NaN-in-URL-filter failure mode where Clover returns empty results
 * because we sent "createdTime>=NaN" instead of "createdTime>=1717804800000".
 *
 * resolvePeriod: collapses the ~100 lines of duplicated period-resolution
 * logic that lived in analytics.ts, orders.ts, smart.ts, etc. Returns
 * inclusive [startMs, endMs] bounds.
 *
 * Both functions intentionally avoid mutating Date objects. The old pattern
 * (`new Date(now.setHours(0, 0, 0, 0))`) silently mutates `now` mid-function,
 * which has bitten the codebase at least twice already.
 */

export function parseDate(input: string, fieldName: string): number {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string, got: ${typeof input}`);
  }
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    throw new Error(
      `${fieldName} is not a parseable date: "${input}". ` +
      `Use ISO 8601 (e.g. "2026-06-01" or "2026-06-01T14:30:00Z").`
    );
  }
  return ms;
}

/**
 * Parse an END date/time. Bare dates ("2026-06-05") mean "through the end of
 * that day" — users universally expect date ranges inclusive of the end date,
 * and the old behavior (midnight STARTING the end date) silently excluded the
 * final day from tax reports and order lookups. Explicit timestamps
 * ("2026-06-05T14:00:00Z") are honored exactly.
 */
export function parseEndDate(input: string, fieldName: string): number {
  const ms = parseDate(input, fieldName);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    return ms + 24 * 60 * 60 * 1000 - 1;
  }
  return ms;
}

export type Period = "today" | "yesterday" | "week" | "month" | "custom";

export interface PeriodBounds {
  startMs: number;
  endMs: number;
  label: string;
}

/**
 * Resolve a period name to inclusive [start, end] timestamps in ms.
 *
 * Note: "today" runs from local-midnight to "now". "week" is a rolling
 * 7-day window ending now. "month" is calendar-month-to-date.
 *
 * Timezone caveat: uses Date(year, month, day) which is LOCAL time. On a
 * server running in UTC that means "today" is UTC midnight, not the
 * restaurant's local midnight. Phase 3 introduces a timezone parameter;
 * for now, document loudly in tool descriptions.
 */
export function resolvePeriod(
  period: Period,
  customStart?: string,
  customEnd?: string
): PeriodBounds {
  if (period === "custom") {
    if (!customStart || !customEnd) {
      throw new Error("startDate and endDate are required when period=custom");
    }
    const startMs = parseDate(customStart, "startDate");
    const endMs = parseEndDate(customEnd, "endDate");
    if (endMs < startMs) {
      throw new Error(`endDate (${customEnd}) is before startDate (${customStart}).`);
    }
    return { startMs, endMs, label: `${customStart} to ${customEnd}` };
  }

  const nowMs = Date.now();
  const now = new Date(nowMs);

  if (period === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { startMs: start.getTime(), endMs: nowMs, label: "today" };
  }
  if (period === "yesterday") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, -1);
    return { startMs: start.getTime(), endMs: end.getTime(), label: "yesterday" };
  }
  if (period === "week") {
    return {
      startMs: nowMs - 7 * 24 * 60 * 60 * 1000,
      endMs: nowMs,
      label: "last 7 days",
    };
  }
  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { startMs: start.getTime(), endMs: nowMs, label: "month-to-date" };
  }
  // Exhaustiveness check.
  const _exhaustive: never = period;
  throw new Error(`Unknown period: ${String(_exhaustive)}`);
}
