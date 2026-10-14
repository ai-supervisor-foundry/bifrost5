import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify } from 'yaml';
import type { RouteSpec } from '../domain/routeSpec.ts';
import { isValidId } from '../domain/routeSpec.ts';
import type { RouteRenderPort } from '../domain/ports.ts';
import { atomicWrite } from './fileStore.ts';

const MANAGED_MARKER = '# managed-by: edgekit';
const HOST_REGEX = /^[a-z0-9.-]+$/;

export class TraefikFileRenderer implements RouteRenderPort {
  private dynamicDir: string;

  constructor(dynamicDir: string) {
    this.dynamicDir = dynamicDir;
  }

  private validateSpec(spec: RouteSpec): void {
    if (!spec.host || !HOST_REGEX.test(spec.host)) {
      throw new Error(`Invalid host '${spec.host}': host contains character outside [a-z0-9.-]`);
    }

    if (!isValidId(spec.id)) {
      throw new Error(`Invalid id '${spec.id}': id must match <owner>--<name>`);
    }

    const parts = spec.id.split('--');
    const owner = parts[0];
    if (spec.owner && spec.owner !== owner) {
      throw new Error(`Invalid id '${spec.id}': owner mismatch with '${spec.owner}'`);
    }
  }

  async write(spec: RouteSpec): Promise<void> {
    this.validateSpec(spec);

    const targetPath = path.join(this.dynamicDir, `${spec.id}.yml`);

    try {
      const existingContent = await fs.readFile(targetPath, 'utf8');
      if (!existingContent.startsWith(MANAGED_MARKER)) {
        throw new Error(`Refusing to overwrite unmanaged file '${targetPath}'`);
      }
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        throw err;
      }
    }

    const pathPrefix = spec.pathPrefix.replace(/\/+$/, '');

    // Middlewares in exact order:
    // 1. edgekit-security@file FIRST
    // 2. strip-<id> (stripPrefix middleware only when spec.stripPrefix)
    // 3. edgekit-access-jwt@file when spec.access is 'private'
    const middlewares: string[] = ['edgekit-security@file'];

    if (spec.stripPrefix) {
      middlewares.push(`strip-${spec.id}`);
    }

    if (spec.access === 'private') {
      middlewares.push('edgekit-access-jwt@file');
    }

    const barePath = `/p/${spec.id}`;
    const slashPath = `/p/${spec.id}/`;
    const bareRouterId = `${spec.id}-bare`;
    const slashMiddlewareId = `slash-${spec.id}`;

    const httpObj: Record<string, any> = {
      routers: {
        [spec.id]: {
          rule: `Host(\`${spec.host}\`) && PathPrefix(\`${slashPath}\`)`,
          service: spec.id,
          middlewares,
        },
        [bareRouterId]: {
          rule: `Host(\`${spec.host}\`) && Path(\`${barePath}\`)`,
          service: 'noop@internal',
          middlewares: ['edgekit-security@file', slashMiddlewareId],
        },
      },
    };

    httpObj.middlewares = {
      [slashMiddlewareId]: {
        redirectRegex: {
          regex: `^https?://[^/]+/p/${spec.id}$`,
          replacement: `/p/${spec.id}/`,
          permanent: false,
        },
      },
    };

    if (spec.stripPrefix) {
      httpObj.middlewares[`strip-${spec.id}`] = {
        stripPrefix: {
          prefixes: [pathPrefix],
        },
      };
    }

    httpObj.services = {
      [spec.id]: {
        loadBalancer: {
          servers: [{ url: spec.target }],
        },
      },
    };

    const doc = {
      http: httpObj,
    };

    const yamlContent = `${MANAGED_MARKER}\n` + stringify(doc);
    await atomicWrite(targetPath, yamlContent);
  }

  async remove(id: string): Promise<boolean> {
    if (!isValidId(id)) {
      throw new Error(`Invalid id '${id}': id must match <owner>--<name>`);
    }

    const filePath = path.join(this.dynamicDir, `${id}.yml`);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (!content.startsWith(MANAGED_MARKER)) {
        return false;
      }
      await fs.unlink(filePath);
      return true;
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  async listIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dynamicDir);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const ids: string[] = [];
    for (const name of entries) {
      if (!name.endsWith('.yml')) {
        continue;
      }
      if (name === 'security.yml') {
        continue;
      }
      const filePath = path.join(this.dynamicDir, name);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        if (!content.startsWith(MANAGED_MARKER)) {
          continue;
        }
        ids.push(name.slice(0, -'.yml'.length));
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
          continue;
        }
        throw err;
      }
    }

    return ids.sort();
  }
}
