export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h > 0 && m < 10 ? `0${m}` : String(m);
  const ss = s < 10 ? `0${s}` : String(s);
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "in 23 h", "in 5 min", "expired", "never" for unix-second expiries. */
export function formatExpiry(expiresAtSec: number, nowMs: number): string {
  if (!expiresAtSec) return 'never expires';
  const left = expiresAtSec - nowMs / 1000;
  if (left <= 0) return 'expired';
  if (left < 3600) return `expires in ${Math.max(1, Math.round(left / 60))} min`;
  if (left < 86400 * 2) return `expires in ${Math.round(left / 3600)} h`;
  return `expires in ${Math.round(left / 86400)} d`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}
