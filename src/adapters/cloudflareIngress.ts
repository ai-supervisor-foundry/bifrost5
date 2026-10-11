import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface TunnelIngressRule {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TunnelIngressOpts {
  dryRun: boolean;
}

export interface TunnelIngressPort {
  addHost(
    hostname: string,
    service: string,
    opts: TunnelIngressOpts
  ): Promise<{ changed: boolean; diff: string }>;
  removeHost(
    hostname: string,
    opts: TunnelIngressOpts
  ): Promise<{ changed: boolean; diff: string }>;
}

export interface CloudflareIngressConfig {
  ingress: TunnelIngressRule[];
  [key: string]: unknown;
}

export interface CloudflareConfigurationsResponse {
  result?: {
    config?: CloudflareIngressConfig;
    [key: string]: unknown;
  };
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
  [key: string]: unknown;
}

/**
 * Cloudflare tunnel configuration API endpoint path template.
 * The tunnel configuration API accepts GET and PUT of the ingress list (source: https://developers.cloudflare.com/api/)
 * at /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations with no ETag required or supported.
 */
export const TUNNEL_CONFIG_PATH_TEMPLATE = '/client/v4/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations';

const DEFAULT_LOCK_STALE_MS = 15_000;
const DEFAULT_LOCK_POLL_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exclusive-create ("flock-style") lock file. Mutual exclusion comes from the
 * atomicity of O_EXCL open, not an OS flock() syscall, since the latter has no
 * built-in way to notice an abandoned lock. A unique token per acquisition
 * guards release: we only unlink the file if it still holds our token, so a
 * waiter that reclaimed a stale lock never has its new lock deleted by the
 * original (crashed) holder's delayed `finally`.
 */
async function acquireLock(
  lockFilePath: string,
  opts: { staleMs: number; pollIntervalMs: number; timeoutMs: number }
): Promise<string> {
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + opts.timeoutMs;

  for (;;) {
    await fs.mkdir(path.dirname(lockFilePath), { recursive: true });
    try {
      const handle = await fs.open(lockFilePath, 'wx');
      try {
        await handle.writeFile(`${token}:${process.pid}:${Date.now()}`, 'utf8');
      } finally {
        await handle.close();
      }
      return token;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'EEXIST') {
        throw err;
      }

      let stat: { mtimeMs: number } | undefined;
      try {
        stat = await fs.stat(lockFilePath);
      } catch (statErr) {
        const se = statErr as NodeJS.ErrnoException;
        if (se.code !== 'ENOENT') throw statErr;
        // Lock disappeared between EEXIST and stat; retry create immediately.
        continue;
      }

      if (stat && Date.now() - stat.mtimeMs > opts.staleMs) {
        try {
          await fs.unlink(lockFilePath);
        } catch (unlinkErr) {
          const ue = unlinkErr as NodeJS.ErrnoException;
          if (ue.code !== 'ENOENT') throw unlinkErr;
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ingress lock at ${lockFilePath}`);
      }
      await sleep(opts.pollIntervalMs);
    }
  }
}

async function releaseLock(lockFilePath: string, token: string): Promise<void> {
  let current: string;
  try {
    current = await fs.readFile(lockFilePath, 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return;
    throw err;
  }

  // Only remove the lock if it is still ours; otherwise a waiter reclaimed it
  // as stale and we must not delete the new holder's lock.
  if (!current.startsWith(`${token}:`)) {
    return;
  }

  try {
    await fs.unlink(lockFilePath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') throw err;
  }
}

/**
 * Minimal unified-style line diff: only emits '-' / '+' lines for an LCS-based
 * minimal edit script between the two JSON renderings. Unchanged lines
 * (including ones that merely shifted position, e.g. the catch-all rule) are
 * omitted entirely.
 */
function computeLineDiff(beforeText: string, afterText: string): string {
  const before = beforeText.split('\n');
  const after = afterText.split('\n');
  const n = before.length;
  const m = after.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`-${before[i]}`);
      i++;
    } else {
      lines.push(`+${after[j]}`);
      j++;
    }
  }
  while (i < n) {
    lines.push(`-${before[i]}`);
    i++;
  }
  while (j < m) {
    lines.push(`+${after[j]}`);
    j++;
  }

  return lines.join('\n');
}

function redactToken(message: string, token: string): string {
  if (!token) return message;
  return message.split(token).join('[REDACTED]');
}

export function sanitizeError(err: unknown, token: string): Error {
  const originalMessage = err instanceof Error ? err.message : String(err);
  const safeMessage = redactToken(originalMessage, token);
  const safeErr = new Error(safeMessage);
  if (err instanceof Error && err.stack) {
    safeErr.stack = redactToken(err.stack, token);
  }
  return safeErr;
}

export class CloudflareTunnelIngressAdapter implements TunnelIngressPort {
  private readonly fetchFn: typeof fetch;
  private readonly accountId: string;
  private readonly tunnelId: string;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly lockFilePath: string;
  private readonly lockStaleMs: number;
  private readonly lockPollIntervalMs: number;
  private readonly lockTimeoutMs: number;

  constructor(params: {
    fetch: typeof fetch;
    accountId: string;
    tunnelId: string;
    token: string;
    baseUrl?: string;
    lockFilePath?: string;
    lockStaleMs?: number;
    lockPollIntervalMs?: number;
    lockTimeoutMs?: number;
  }) {
    this.fetchFn = params.fetch;
    this.accountId = params.accountId;
    this.tunnelId = params.tunnelId;
    this.token = params.token;
    this.baseUrl = params.baseUrl || 'https://api.cloudflare.com';
    this.lockFilePath = params.lockFilePath
      || path.join(os.tmpdir(), 'edgekit', `ingress-${this.accountId}-${this.tunnelId}.lock`);
    this.lockStaleMs = params.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.lockPollIntervalMs = params.lockPollIntervalMs ?? DEFAULT_LOCK_POLL_MS;
    this.lockTimeoutMs = params.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const token = await acquireLock(this.lockFilePath, {
      staleMs: this.lockStaleMs,
      pollIntervalMs: this.lockPollIntervalMs,
      timeoutMs: this.lockTimeoutMs,
    });
    try {
      return await fn();
    } finally {
      await releaseLock(this.lockFilePath, token);
    }
  }

  private getUrl(): string {
    const urlPath = TUNNEL_CONFIG_PATH_TEMPLATE
      .replace('{account_id}', encodeURIComponent(this.accountId))
      .replace('{tunnel_id}', encodeURIComponent(this.tunnelId));
    return `${this.baseUrl}${urlPath}`;
  }

  private async fetchCurrentConfig(): Promise<{ fullBody: Record<string, unknown>; ingress: TunnelIngressRule[] }> {
    const url = this.getUrl();
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw sanitizeError(err, this.token);
    }

    if (!res.ok) {
      throw new Error(`Failed to GET tunnel configuration: HTTP ${res.status} ${res.statusText}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error('Failed to parse tunnel configuration: invalid JSON response');
    }

    if (!json || typeof json !== 'object') {
      throw new Error('Invalid tunnel configuration response: expected JSON object');
    }

    const bodyObj = json as Record<string, unknown>;
    const result = bodyObj.result as Record<string, unknown> | undefined;
    const config = (result && typeof result === 'object' && result.config && typeof result.config === 'object')
      ? (result.config as Record<string, unknown>)
      : (bodyObj.config && typeof bodyObj.config === 'object' ? (bodyObj.config as Record<string, unknown>) : undefined);

    const ingress = config?.ingress;
    if (!Array.isArray(ingress)) {
      throw new Error('Invalid tunnel configuration response: missing ingress array');
    }

    // Check catch-all rule: a rule without a hostname (or hostname empty/undefined)
    const hasCatchAll = ingress.some((rule: unknown) => {
      if (!rule || typeof rule !== 'object') return false;
      const r = rule as TunnelIngressRule;
      return !r.hostname && typeof r.service === 'string';
    });

    if (!hasCatchAll) {
      throw new Error('Invalid tunnel configuration response: missing catch-all rule');
    }

    return {
      fullBody: bodyObj,
      ingress: ingress as TunnelIngressRule[],
    };
  }

  async addHost(
    hostname: string,
    service: string,
    opts: TunnelIngressOpts
  ): Promise<{ changed: boolean; diff: string }> {
    return this.withLock(async () => {
      try {
        const { fullBody, ingress } = await this.fetchCurrentConfig();

        const catchAllIndex = ingress.findIndex(r => !r.hostname);
        const catchAllRule = ingress[catchAllIndex];
        const specificRules = ingress.filter((_, idx) => idx !== catchAllIndex);

        // The first rule for this hostname is replaced in place; any later duplicates are dropped
        const updatedSpecific: TunnelIngressRule[] = [];
        let placed = false;
        for (const rule of specificRules) {
          if (rule.hostname !== hostname) {
            updatedSpecific.push(rule);
          } else if (!placed) {
            updatedSpecific.push({ ...rule, hostname, service });
            placed = true;
          }
        }
        if (!placed) {
          updatedSpecific.push({ hostname, service });
        }

        const newIngress = [...updatedSpecific, catchAllRule];
        const changed = JSON.stringify(newIngress) !== JSON.stringify(ingress);
        const diff = changed
          ? `--- current\n+++ updated\n${computeLineDiff(JSON.stringify(ingress, null, 2), JSON.stringify(newIngress, null, 2))}`
          : '';

        if (opts.dryRun || !changed) {
          return { changed, diff };
        }

        // Perform PUT
        await this.putConfig(fullBody, newIngress);
        return { changed, diff };
      } catch (err) {
        throw sanitizeError(err, this.token);
      }
    });
  }

  async removeHost(
    hostname: string,
    opts: TunnelIngressOpts
  ): Promise<{ changed: boolean; diff: string }> {
    return this.withLock(async () => {
      try {
        const { fullBody, ingress } = await this.fetchCurrentConfig();

        const catchAllIndex = ingress.findIndex(r => !r.hostname);
        const catchAllRule = ingress[catchAllIndex];

        const specificRules = ingress.filter((_, idx) => idx !== catchAllIndex);
        const existingRuleIndex = specificRules.findIndex(r => r.hostname === hostname);

        if (existingRuleIndex < 0) {
          return { changed: false, diff: '' };
        }

        const updatedSpecific = specificRules.filter(r => r.hostname !== hostname);
        const newIngress = [...updatedSpecific, catchAllRule];

        const diff = `--- current\n+++ updated\n${computeLineDiff(JSON.stringify(ingress, null, 2), JSON.stringify(newIngress, null, 2))}`;

        if (opts.dryRun) {
          return { changed: true, diff };
        }

        await this.putConfig(fullBody, newIngress);
        return { changed: true, diff };
      } catch (err) {
        throw sanitizeError(err, this.token);
      }
    });
  }

  private async putConfig(fullBody: Record<string, unknown>, newIngress: TunnelIngressRule[]): Promise<void> {
    const url = this.getUrl();
    const result = (fullBody.result && typeof fullBody.result === 'object')
      ? (fullBody.result as Record<string, unknown>)
      : undefined;
    const existingConfig = (result?.config && typeof result.config === 'object')
      ? (result.config as Record<string, unknown>)
      : (fullBody.config && typeof fullBody.config === 'object' ? (fullBody.config as Record<string, unknown>) : {});

    const putPayload = {
      config: {
        ...existingConfig,
        ingress: newIngress,
      },
    };

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(putPayload),
      });
    } catch (err) {
      throw sanitizeError(err, this.token);
    }

    if (!res.ok) {
      throw new Error(`Failed to PUT tunnel configuration: HTTP ${res.status} ${res.statusText}`);
    }
  }
}
