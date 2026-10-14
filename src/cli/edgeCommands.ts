import type {
  AccessPolicy,
  AccessPort,
  DnsPort,
  TunnelIngressPort,
} from '../domain/ports.ts';

export interface EdgeCommandOutput {
  hostname: string;
  changed: boolean;
  applied: boolean;
  diff?: string;
  recordId?: string;
  appId?: string;
}

/**
 * dryRun is derived from `apply` here so callers (and their tests) only ever
 * reason about one flag: whichever adapter method fires below is the single
 * place a mutating Cloudflare call could happen.
 */
export async function runEdgeIngress(
  port: TunnelIngressPort,
  hostname: string,
  service: string,
  apply: boolean
): Promise<EdgeCommandOutput> {
  const result = await port.addHost(hostname, service, { dryRun: !apply });
  return { hostname, changed: result.changed, applied: apply, diff: result.diff };
}

export async function runEdgeDns(
  port: DnsPort,
  hostname: string,
  target: string,
  apply: boolean,
  opts: { proxied?: boolean; ttl?: number } = {}
): Promise<EdgeCommandOutput> {
  const result = await port.ensureCname(hostname, target, { dryRun: !apply, ...opts });
  return { hostname, changed: result.changed, applied: apply, diff: result.diff, recordId: result.recordId };
}

export async function runEdgeAccess(
  port: AccessPort,
  hostname: string,
  name: string,
  policy: AccessPolicy,
  apply: boolean
): Promise<EdgeCommandOutput> {
  const result = await port.ensure(hostname, name, policy, { dryRun: !apply });
  return { hostname, changed: result.changed, applied: apply, diff: result.diff, appId: result.appId };
}
