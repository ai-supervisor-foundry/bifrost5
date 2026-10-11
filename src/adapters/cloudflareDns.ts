export interface DnsEnsureOpts {
  dryRun: boolean;
  proxied?: boolean;
  ttl?: number;
}

export interface DnsPort {
  ensureCname(
    hostname: string,
    target: string,
    opts: DnsEnsureOpts
  ): Promise<{ changed: boolean; recordId?: string; diff?: string }>;
  removeCname(
    hostname: string,
    opts: { dryRun: boolean }
  ): Promise<{ changed: boolean; diff?: string }>;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  [key: string]: unknown;
}

export interface CloudflareDnsListResponse {
  result?: DnsRecord[];
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
  [key: string]: unknown;
}

/**
 * Cloudflare DNS records API endpoint path template.
 * UNVERIFIED: this path has not been checked against the Cloudflare API reference yet.
 */
export const DNS_RECORDS_PATH_TEMPLATE = '/client/v4/zones/{zone_id}/dns_records';

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

export class CloudflareDnsAdapter implements DnsPort {
  private readonly fetchFn: typeof fetch;
  private readonly zoneId: string;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(params: {
    fetch: typeof fetch;
    zoneId: string;
    token: string;
    baseUrl?: string;
  }) {
    this.fetchFn = params.fetch;
    this.zoneId = params.zoneId;
    this.token = params.token;
    this.baseUrl = params.baseUrl || 'https://api.cloudflare.com';
  }

  private getBaseUrl(): string {
    const path = DNS_RECORDS_PATH_TEMPLATE.replace('{zone_id}', encodeURIComponent(this.zoneId));
    return `${this.baseUrl}${path}`;
  }

  private async listCnameRecords(hostname: string): Promise<DnsRecord[]> {
    const url = `${this.getBaseUrl()}?type=CNAME&name=${encodeURIComponent(hostname)}`;
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
      throw new Error(`Failed to list DNS records: HTTP ${res.status} ${res.statusText}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error('Failed to parse DNS list response: invalid JSON');
    }

    if (!json || typeof json !== 'object') {
      throw new Error('Invalid DNS list response: expected JSON object');
    }

    const bodyObj = json as CloudflareDnsListResponse;
    if (!Array.isArray(bodyObj.result)) {
      throw new Error('Invalid DNS list response: missing result array');
    }

    return bodyObj.result;
  }

  async ensureCname(
    hostname: string,
    target: string,
    opts: DnsEnsureOpts
  ): Promise<{ changed: boolean; recordId?: string; diff?: string }> {
    try {
      const records = await this.listCnameRecords(hostname);
      const proxied = opts.proxied ?? true;
      const ttl = opts.ttl ?? 1; // 1 = automatic in Cloudflare

      // Check if matching record exists
      const existing = records.find(r => r.name === hostname && r.type === 'CNAME');

      if (existing) {
        if (existing.content === target && (existing.proxied === proxied || opts.proxied === undefined)) {
          // Idempotent: nothing to change
          return { changed: false, recordId: existing.id, diff: '' };
        }

        // Needs update
        const diff = `--- ${hostname} CNAME ${existing.content}\n+++ ${hostname} CNAME ${target}`;
        if (opts.dryRun) {
          return { changed: true, recordId: existing.id, diff };
        }

        const updateUrl = `${this.getBaseUrl()}/${encodeURIComponent(existing.id)}`;
        const res = await this.fetchFn(updateUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'CNAME',
            name: hostname,
            content: target,
            proxied,
            ttl,
          }),
        });

        if (!res.ok) {
          throw new Error(`Failed to update DNS record: HTTP ${res.status} ${res.statusText}`);
        }

        return { changed: true, recordId: existing.id, diff };
      }

      // Needs create
      const diff = `+ ${hostname} CNAME ${target}`;
      if (opts.dryRun) {
        return { changed: true, diff };
      }

      const res = await this.fetchFn(this.getBaseUrl(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'CNAME',
          name: hostname,
          content: target,
          proxied,
          ttl,
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to create DNS record: HTTP ${res.status} ${res.statusText}`);
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        // Fallback if no JSON response
      }

      const createdId = (json && typeof json === 'object' && (json as any).result && (json as any).result.id)
        ? (json as any).result.id
        : undefined;

      return { changed: true, recordId: createdId, diff };
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
  }

  async removeCname(
    hostname: string,
    opts: { dryRun: boolean }
  ): Promise<{ changed: boolean; diff?: string }> {
    try {
      const records = await this.listCnameRecords(hostname);
      const existing = records.find(r => r.name === hostname && r.type === 'CNAME');

      if (!existing) {
        return { changed: false, diff: '' };
      }

      const diff = `- ${hostname} CNAME ${existing.content}`;
      if (opts.dryRun) {
        return { changed: true, diff };
      }

      const deleteUrl = `${this.getBaseUrl()}/${encodeURIComponent(existing.id)}`;
      const res = await this.fetchFn(deleteUrl, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to delete DNS record: HTTP ${res.status} ${res.statusText}`);
      }

      return { changed: true, diff };
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
  }
}
