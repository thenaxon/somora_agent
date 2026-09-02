// Copy a string to the clipboard, with a graceful fallback for the
// cases where the Clipboard API is missing (non-secure context, old
// WebView) or rejects (no user gesture, permission denied). The
// fallback selects the text inside `fallbackEl` so a plain Ctrl+C
// still works — the caller tells the user to do that.

export type CopyOutcome = 'copied' | 'selected' | 'failed';

export async function copyTextOrSelect(
  text: string,
  fallbackEl?: HTMLElement | null,
): Promise<CopyOutcome> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch {
    // fall through to the selection fallback
  }
  return selectElementText(fallbackEl) ? 'selected' : 'failed';
}

// Select the whole text content of an element (document range
// selection). Returns false when there is nothing to select on.
export function selectElementText(el?: HTMLElement | null): boolean {
  if (!el || typeof document === 'undefined' || typeof window === 'undefined') return false;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  } catch {
    return false;
  }
}
