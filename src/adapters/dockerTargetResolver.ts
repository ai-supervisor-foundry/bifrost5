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
type InspectDetail = {
  Id?: string;
  Config?: { Labels?: Record<string, string> | null };
  NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null }> | null };
};
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
    const containers = Object.entries(net.Containers ?? {});
    // `docker network inspect` carries no aliases or labels; fetch them per container.
    const details = new Map<string, InspectDetail>();
    const needDetail = containers.filter(([, c]) => c.Aliases === undefined).map(([id]) => id);
    if (needDetail.length > 0) {
      const detailOut = await this.run(['inspect', ...needDetail]);
      for (const d of JSON.parse(detailOut) as InspectDetail[]) {
        if (d && typeof d.Id === 'string') details.set(d.Id, d);
      }
    }
    const results: ResolvedTarget[] = [];
    for (const [id, c] of containers) {
      const detail = details.get(id);
      const aliases = c.Aliases ?? detail?.NetworkSettings?.Networks?.[this.network]?.Aliases ?? null;
      const names = aliases && aliases.length > 0 ? aliases : c.Name ? [c.Name] : [];
      if (!names.includes(alias) || !c.IPv4Address) continue;
      const t: ResolvedTarget = { ip: c.IPv4Address.split('/')[0], container: c.Name ?? '' };
      const labels = detail?.Config?.Labels;
      if (labels && Object.keys(labels).length > 0) t.labels = labels;
      if (subnet) t.subnet = subnet;
      results.push(t);
    }
    return results;
  }
}
