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
  /** Maps a non-IPv4 target host (e.g. a Docker alias) to the container IPs serving it. */
  resolveHost?: (host: string) => Promise<string[]>;
}

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const NOTFOUND_HEADER = 'x-edgekit-notfound';
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Returns the base URL to probe, or a failure reason when the alias cannot be pinned to one container. */
async function probeBase(
  target: string,
  resolveHost?: (host: string) => Promise<string[]>
): Promise<{ base: string } | { reason: string }> {
  if (!resolveHost) return { base: target };
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return { base: target };
  }
  if (IPV4.test(u.hostname)) return { base: target };
  let ips: string[];
  try {
    ips = await resolveHost(u.hostname);
  } catch (err: unknown) {
    return { reason: `alias ${u.hostname} resolution failed (${err instanceof Error ? err.message : String(err)})` };
  }
  if (ips.length === 0) return { reason: `alias ${u.hostname} matches no container` };
  if (ips.length > 1) return { reason: `alias ${u.hostname} matches ${ips.length} containers` };
  // URL drops default ports (":80"); keep the operator's explicit port as written.
  const explicitPort = /^[a-z][a-z0-9+.-]*:\/\/[^/:]+:(\d+)/i.exec(target)?.[1];
  const port = explicitPort ?? u.port;
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return { base: `${u.protocol}//${ips[0]}${port ? `:${port}` : ''}${path}` };
}

async function checkOne(
  route: CheckableRoute,
  fetchFn: FetchFn,
  retries: number,
  timeoutMs: number,
  probePath: string,
  resolveHost?: (host: string) => Promise<string[]>
): Promise<CheckResult> {
  const probe = await probeBase(route.target, resolveHost);
  if ('reason' in probe) return { id: route.id, target: route.target, ok: false, reason: probe.reason };
  const url = `${probe.base}${probePath}`;
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
  const { retries = 2, timeoutMs = 3000, probePath = '/', resolveHost } = opts;
  return Promise.all(routes.map((r) => checkOne(r, fetchFn, retries, timeoutMs, probePath, resolveHost)));
}
