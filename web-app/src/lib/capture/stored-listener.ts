/** The listener this browser registered, kept in `localStorage`; light enough for the page to read without loading the capture engine. */
export const LISTENER_KEY = 'sanctum.listener';

/** The stored listener's id; the server validates it when it is sent back, so a damaged value only fails that read. */
export function storedListenerId(storage: Pick<Storage, 'getItem'> = localStorage): string | null {
  try {
    const stored: unknown = JSON.parse(storage.getItem(LISTENER_KEY) ?? 'null');
    return typeof stored === 'object' && stored !== null && 'id' in stored && typeof stored.id === 'string' ? stored.id : null;
  } catch {
    return null;
  }
}
