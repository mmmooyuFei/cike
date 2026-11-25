const START_KEY = "cike.oidc.startedAt";
const RETRY_KEY = "cike.oidc.retries";
const TTL_MS = 20_000;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function oidcStartRemainingMs(now = Date.now()): number | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(START_KEY);
  if (!raw) return null;
  const startedAt = Number(raw);
  if (!Number.isFinite(startedAt)) return null;
  const age = now - startedAt;
  if (age < 0 || age >= TTL_MS) return null;
  return TTL_MS - age;
}

export function markOidcStart(now = Date.now()): void {
  try {
    storage()?.setItem(START_KEY, String(now));
  } catch {
    /* storage unavailable: fall back to no de-duplication */
  }
}

export function clearOidcStart(): void {
  try {
    storage()?.removeItem(START_KEY);
  } catch {
    /* ignore */
  }
}

export function oidcRetryCount(): number {
  try {
    return Number(storage()?.getItem(RETRY_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

export function bumpOidcRetry(): number {
  const next = oidcRetryCount() + 1;
  try {
    storage()?.setItem(RETRY_KEY, String(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function clearOidcRetry(): void {
  try {
    storage()?.removeItem(RETRY_KEY);
  } catch {
    /* ignore */
  }
}

export function isTransientOidcError(code: string | null): boolean {
  return code === "oidc_token_exchange_failed" || code === "oidc_discovery_failed" || code === "oidc_userinfo_failed";
}
