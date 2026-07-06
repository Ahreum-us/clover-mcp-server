/**
 * Shared collector for Promise.allSettled results over Clover items.
 *
 * Extracted per CodeRabbit review on PR #37: the { itemId, itemName, error }
 * failure shape was copy-pasted across seasonal_menu_toggle,
 * bulk_update_prices, and set_happy_hour_prices — and had already drifted
 * apart once (name-only vs id+name). One definition, one place to change.
 */
export interface SettledFailure {
  itemId: string;
  itemName: string;
  error: string;
}

export function collectSettled<T>(
  settled: PromiseSettledResult<T>[],
  items: any[]
): { succeeded: T[]; failed: SettledFailure[] } {
  const succeeded: T[] = [];
  const failed: SettledFailure[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") succeeded.push(r.value);
    else failed.push({
      itemId: items[i]?.id ?? "unknown",
      itemName: items[i]?.name ?? "unknown",
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    });
  });
  return { succeeded, failed };
}
