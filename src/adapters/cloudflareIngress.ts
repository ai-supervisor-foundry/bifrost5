export interface TunnelIngressRule {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TunnelIngressPort {
  addHost(
    hostname: string,
    service: string,
    opts?: { dryRun?: boolean }
  ): Promise<{ changed: boolean; diff: string }>;
  removeHost(
    hostname: string,
    opts?: { dryRun?: boolean }
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

  constructor(params: {
    fetch: typeof fetch;
    accountId: string;
    tunnelId: string;
    token: string;
    baseUrl?: string;
  }) {
    this.fetchFn = params.fetch;
    this.accountId = params.accountId;
    this.tunnelId = params.tunnelId;
    this.token = params.token;
    this.baseUrl = params.baseUrl || 'https://api.cloudflare.com';
  }

  private getUrl(): string {
    const path = TUNNEL_CONFIG_PATH_TEMPLATE
      .replace('{account_id}', encodeURIComponent(this.accountId))
      .replace('{tunnel_id}', encodeURIComponent(this.tunnelId));
    return `${this.baseUrl}${path}`;
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
    opts?: { dryRun?: boolean }
  ): Promise<{ changed: boolean; diff: string }> {
    try {
      const { fullBody, ingress } = await this.fetchCurrentConfig();

      // Separate catch-all rule(s) and specific rules
      const catchAllIndex = ingress.findIndex(r => !r.hostname);
      const catchAllRule = ingress[catchAllIndex];

      const specificRules = ingress.filter((_, idx) => idx !== catchAllIndex);

      // Check if rule for same hostname already exists
      const existingRuleIndex = specificRules.findIndex(r => r.hostname === hostname);
      let changed = false;

      const newRule: TunnelIngressRule = { hostname, service };
      const updatedSpecific = [...specificRules];

      if (existingRuleIndex >= 0) {
        const existing = updatedSpecific[existingRuleIndex];
        if (existing.service !== service) {
          updatedSpecific[existingRuleIndex] = { ...existing, service };
          changed = true;
        } else {
          changed = false;
        }
      } else {
        updatedSpecific.push(newRule);
        changed = true;
      }

      // Catch-all rule is ALWAYS last
      const newIngress = [...updatedSpecific, catchAllRule];

      const oldJson = JSON.stringify(ingress, null, 2);
      const newJson = JSON.stringify(newIngress, null, 2);
      const diff = changed ? `--- current\n+++ updated\n${newJson}` : '';

      if (opts?.dryRun || !changed) {
        return { changed, diff };
      }

      // Perform PUT
      await this.putConfig(fullBody, newIngress);
      return { changed, diff };
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
  }

  async removeHost(
    hostname: string,
    opts?: { dryRun?: boolean }
  ): Promise<{ changed: boolean; diff: string }> {
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

      const newJson = JSON.stringify(newIngress, null, 2);
      const diff = `--- current\n+++ updated\n${newJson}`;

      if (opts?.dryRun) {
        return { changed: true, diff };
      }

      await this.putConfig(fullBody, newIngress);
      return { changed: true, diff };
    } catch (err) {
      throw sanitizeError(err, this.token);
    }
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
