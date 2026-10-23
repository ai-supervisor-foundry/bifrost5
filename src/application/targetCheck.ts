export interface CheckableRoute {
  id: string;
  target: string;
}

export interface CheckResult {
  id: string;
  target: string;
  ok: boolean;
  reason?: string;
}

export interface CheckOptions {
  retries?: number;
  timeoutMs?: number;
  probePath?: string;
}

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const NOTFOUND_HEADER = 'x-edgekit-notfound';

async function checkOne(
  route: CheckableRoute,
  fetchFn: FetchFn,
  retries: number,
  timeoutMs: number,
  probePath: string
): Promise<CheckResult> {
  const url = `${route.target}${probePath}`;
  let lastReason = 'no answer';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: ctrl.signal });
      if (res.headers.get(NOTFOUND_HEADER) === '1') {
        return { id: route.id, target: route.target, ok: false, reason: 'target serves edgekit notfound page' };
      }
      if (res.status < 500) {
        return { id: route.id, target: route.target, ok: true };
      }
      lastReason = `HTTP ${res.status}`;
    } catch (err: unknown) {
      lastReason = `no answer (${err instanceof Error ? err.message : String(err)})`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { id: route.id, target: route.target, ok: false, reason: lastReason };
}

/** Report-only probe: GETs each route target. Never touches the store or renderer. */
export async function checkRoutes(
  routes: CheckableRoute[],
  fetchFn: FetchFn,
  opts: CheckOptions = {}
): Promise<CheckResult[]> {
  const { retries = 2, timeoutMs = 3000, probePath = '/' } = opts;
  return Promise.all(routes.map((r) => checkOne(r, fetchFn, retries, timeoutMs, probePath)));
}
