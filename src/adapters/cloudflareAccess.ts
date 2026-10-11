import type {
  AccessApp,
  AccessEnsureOpts,
  AccessPolicy,
  AccessPort,
} from '../domain/ports.ts';

export interface AccessAppRaw {
  id: string;
  name: string;
  domain: string;
  policies?: unknown[];
  [key: string]: unknown;
}

export interface CloudflareAccessListResponse {
  result?: AccessAppRaw[];
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
  [key: string]: unknown;
}

/**
 * Cloudflare Access Applications API endpoint path template.
 * UNVERIFIED: this path has not been checked against the Cloudflare API reference yet.
 */
export const ACCESS_APPS_PATH_TEMPLATE = '/client/v4/accounts/{account_id}/access/apps';

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

export class CloudflareAccessAdapter implements AccessPort {
  private readonly fetchFn: typeof fetch;
  private readonly accountId: string;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(params: {
    fetch: typeof fetch;
    accountId: string;
    token: string;
    baseUrl?: string;
  }) {
    this.fetchFn = params.fetch;
    this.accountId = params.accountId;
    this.token = params.token;
    this.baseUrl = params.baseUrl || 'https://api.cloudflare.com';
  }

  private getBaseUrl(): string {
    const urlPath = ACCESS_APPS_PATH_TEMPLATE.replace('{account_id}', encodeURIComponent(this.accountId));
    return `${this.baseUrl}${urlPath}`;
  }

  private getAppUrl(appId: string): string {
    return `${this.getBaseUrl()}/${encodeURIComponent(appId)}`;
  }

  private async listApps(): Promise<AccessApp[]> {
    const url = this.getBaseUrl();
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
      throw new Error(`Failed to list Access apps: HTTP ${res.status} ${res.statusText}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error('Failed to parse Access apps list response: invalid JSON');
    }

    if (!json || typeof json !== 'object') {
      throw new Error('Invalid Access apps list response: expected JSON object');
    }

    const bodyObj = json as CloudflareAccessListResponse;
    if (!Array.isArray(bodyObj.result)) {
      throw new Error('Invalid Access apps list response: missing result array');
    }

    return bodyObj.result.map((app) => ({
      id: String(app.id),
      name: String(app.name),
      domain: String(app.domain),
      policies: Array.isArray(app.policies) ? (app.policies as AccessPolicy[]) : undefined,
    }));
  }

  async list(): Promise<AccessApp[]> {
    try {
      return await this.listApps();
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
  }

  async ensure(
    hostname: string,
    name: string,
    policy: AccessPolicy,
    opts: AccessEnsureOpts
  ): Promise<{ changed: boolean; appId?: string; diff?: string }> {
    try {
      const apps = await this.listApps();
      const existing = apps.find((a) => a.domain === hostname);
      const desiredPolicies = [policy];

      if (existing) {
        const samePolicies = JSON.stringify(existing.policies ?? []) === JSON.stringify(desiredPolicies);
        if (existing.name === name && samePolicies) {
          // Idempotent: nothing to change
          return { changed: false, appId: existing.id, diff: '' };
        }

        const diff = `--- ${hostname} AccessApp ${JSON.stringify({ name: existing.name, policies: existing.policies ?? [] })}\n`
          + `+++ ${hostname} AccessApp ${JSON.stringify({ name, policies: desiredPolicies })}`;

        if (opts.dryRun) {
          return { changed: true, appId: existing.id, diff };
        }

        await this.updateApp(existing.id, hostname, name, desiredPolicies);
        return { changed: true, appId: existing.id, diff };
      }

      const diff = `+ ${hostname} AccessApp ${JSON.stringify({ name, policies: desiredPolicies })}`;

      if (opts.dryRun) {
        return { changed: true, diff };
      }

      const appId = await this.createApp(hostname, name, desiredPolicies);
      return { changed: true, appId, diff };
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
  }

  async remove(
    hostname: string,
    opts: AccessEnsureOpts
  ): Promise<{ changed: boolean; diff?: string }> {
    try {
      const apps = await this.listApps();
      const existing = apps.find((a) => a.domain === hostname);

      if (!existing) {
        return { changed: false, diff: '' };
      }

      const diff = `- ${hostname} AccessApp ${JSON.stringify({ name: existing.name, policies: existing.policies ?? [] })}`;

      if (opts.dryRun) {
        return { changed: true, diff };
      }

      await this.deleteApp(existing.id);
      return { changed: true, diff };
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
  }

  private async createApp(hostname: string, name: string, policies: AccessPolicy[]): Promise<string | undefined> {
    const res = await this.fetchFn(this.getBaseUrl(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, domain: hostname, policies }),
    });

    if (!res.ok) {
      throw new Error(`Failed to create Access app: HTTP ${res.status} ${res.statusText}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      // Fallback if no JSON response
    }

    const createdId = (json && typeof json === 'object' && (json as any).result && (json as any).result.id)
      ? String((json as any).result.id)
      : undefined;

    return createdId;
  }

  private async updateApp(appId: string, hostname: string, name: string, policies: AccessPolicy[]): Promise<void> {
    const res = await this.fetchFn(this.getAppUrl(appId), {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, domain: hostname, policies }),
    });

    if (!res.ok) {
      throw new Error(`Failed to update Access app: HTTP ${res.status} ${res.statusText}`);
    }
  }

  private async deleteApp(appId: string): Promise<void> {
    const res = await this.fetchFn(this.getAppUrl(appId), {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to delete Access app: HTTP ${res.status} ${res.statusText}`);
    }
  }
}
