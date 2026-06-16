export const ENTITLEMENT_GRACE_MS = 24 * 60 * 60 * 1000;

export type EntitlementStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | string;

export interface BillingCache {
  status: EntitlementStatus;
  trialEnd?: string | null;
  currentPeriodEnd?: string | null;
  manageUrl?: string | null;
  checkedAt: string;
}

export interface EntitlementResponse {
  ok?: boolean;
  status: EntitlementStatus;
  trialEnd?: string | null;
  currentPeriodEnd?: string | null;
  manageUrl?: string | null;
  error?: string;
}

export function isEntitlementActive(status: EntitlementStatus | null | undefined): boolean {
  return status === 'trialing' || status === 'active';
}

export function isGraceValid(
  checkedAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!checkedAt) return false;
  const parsed = Date.parse(checkedAt);
  if (Number.isNaN(parsed)) return false;
  return nowMs - parsed <= ENTITLEMENT_GRACE_MS;
}

export function billingCacheFromSections(sections: Record<string, unknown> | null | undefined): BillingCache | null {
  const raw = sections && sections.billing;
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const status = row.status != null ? String(row.status) : '';
  const checkedAt = row.checkedAt != null ? String(row.checkedAt) : '';
  if (!status || !checkedAt) return null;
  return {
    status,
    trialEnd: row.trialEnd != null ? String(row.trialEnd) : null,
    currentPeriodEnd: row.currentPeriodEnd != null ? String(row.currentPeriodEnd) : null,
    manageUrl: row.manageUrl != null ? String(row.manageUrl) : null,
    checkedAt,
  };
}

export function billingCacheToPayload(cache: BillingCache): Record<string, unknown> {
  return {
    section: 'billing',
    status: cache.status,
    trialEnd: cache.trialEnd ?? null,
    currentPeriodEnd: cache.currentPeriodEnd ?? null,
    manageUrl: cache.manageUrl ?? null,
    checkedAt: cache.checkedAt,
  };
}

export function resolveEntitlement(params: {
  network: EntitlementResponse | null;
  cache: BillingCache | null;
  nowMs?: number;
}): { allowed: boolean; status: EntitlementStatus; source: 'network' | 'cache' | 'none'; cache: BillingCache | null } {
  const nowMs = params.nowMs ?? Date.now();

  if (params.network && params.network.status && params.network.status !== 'none') {
    const cache: BillingCache = {
      status: params.network.status,
      trialEnd: params.network.trialEnd ?? null,
      currentPeriodEnd: params.network.currentPeriodEnd ?? null,
      manageUrl: params.network.manageUrl ?? null,
      checkedAt: new Date(nowMs).toISOString(),
    };
    return {
      allowed: isEntitlementActive(params.network.status),
      status: params.network.status,
      source: 'network',
      cache,
    };
  }

  if (params.network && params.network.status === 'none') {
    return { allowed: false, status: 'none', source: 'network', cache: null };
  }

  const cache = params.cache;
  if (cache && isEntitlementActive(cache.status) && isGraceValid(cache.checkedAt, nowMs)) {
    return { allowed: true, status: cache.status, source: 'cache', cache };
  }

  return {
    allowed: false,
    status: cache?.status || 'none',
    source: 'none',
    cache: null,
  };
}

export async function fetchEntitlementFromWeb(
  webAppUrl: string,
  token: string,
): Promise<EntitlementResponse> {
  const res = await fetch(`${webAppUrl.replace(/\/$/, '')}/api/entitlement`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(String(data.error || `entitlement HTTP ${res.status}`));
  }
  return data as EntitlementResponse;
}
