import { execFile } from 'node:child_process';
import type { ResolvedTarget, TargetResolverPort } from '../domain/ports.ts';

export type DockerRun = (args: string[]) => Promise<string>;

const defaultRun: DockerRun = (args) =>
  new Promise((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

type InspectContainer = { Name?: string; IPv4Address?: string; Aliases?: string[] | null };
type InspectNetwork = {
  IPAM?: { Config?: { Subnet?: string }[] | null };
  Containers?: Record<string, InspectContainer> | null;
};

export class DockerTargetResolver implements TargetResolverPort {
  private network: string;
  private run: DockerRun;

  constructor(opts: { network?: string; run?: DockerRun } = {}) {
    this.network = opts.network ?? 'edgekit-net';
    this.run = opts.run ?? defaultRun;
  }

  async resolve(alias: string): Promise<ResolvedTarget[]> {
    const out = await this.run(['network', 'inspect', this.network]);
    const parsed = JSON.parse(out) as InspectNetwork[];
    const net = parsed[0];
    if (!net) return [];
    const subnet = (net.IPAM?.Config ?? []).map(c => c.Subnet).find(s => typeof s === 'string' && !s.includes(':'));
    const results: ResolvedTarget[] = [];
    for (const c of Object.values(net.Containers ?? {})) {
      const names = c.Aliases && c.Aliases.length > 0 ? c.Aliases : c.Name ? [c.Name] : [];
      if (!names.includes(alias) || !c.IPv4Address) continue;
      const t: ResolvedTarget = { ip: c.IPv4Address.split('/')[0], container: c.Name ?? '' };
      if (subnet) t.subnet = subnet;
      results.push(t);
    }
    return results;
  }
}
