/**
 * The "did we already try once in this tab" latch for the silent sync.
 *
 * Why it is needed at all, given the catalog already has a 24h TTL: the TTL only
 * stops a *successful* sync from repeating. A failed one (GitHub unreachable)
 * writes `lastError` and leaves `syncedAt` untouched, so every editor open in
 * that state would retry — and the retry is a 15s network timeout each time. The
 * seller opens a lot of product pages in a day; "one attempt per page load" is
 * the right frequency, and this is that frequency.
 *
 * Module-scoped on purpose: each editor tab gets its own module instance, so the
 * latch dies with the tab and a reload is a fresh attempt. Nothing is persisted.
 */

let attempted = false;

/** Mark the one attempt this tab gets. Returns false if it was already taken. */
export function claimSilentSyncAttempt(): boolean {
  if (attempted) return false;
  attempted = true;
  return true;
}
