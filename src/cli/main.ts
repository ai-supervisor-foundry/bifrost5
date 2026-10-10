import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { RouteManager } from '../application/routeManager.ts';
import { FileRouteStore } from '../adapters/fileStore.ts';
import { TraefikFileRenderer } from '../adapters/traefikRenderer.ts';
import { FileQuotaState } from '../adapters/fileQuotaState.ts';
import { deriveId, type Policy } from '../domain/routeSpec.ts';
import type { Clock } from '../domain/ports.ts';

class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}

function parseArgs(args: string[]): { command: string; flags: Record<string, string | boolean>; positionals: string[] } {
  const command = args[0] || '';
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--no-strip') {
      flags['strip'] = false;
      i++;
    } else if (arg.startsWith('--')) {
      const flagName = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg !== undefined && !nextArg.startsWith('--')) {
        flags[flagName] = nextArg;
        i += 2;
      } else {
        flags[flagName] = true;
        i++;
      }
    } else {
      positionals.push(arg);
      i++;
    }
  }

  return { command, flags, positionals };
}

async function main() {
  const args = process.argv.slice(2);
  const { command, flags, positionals } = parseArgs(args);

  const stateDir = process.env.EDGEKIT_STATE_DIR;
  const dynamicDir = process.env.EDGEKIT_DYNAMIC_DIR;
  const policyFile = process.env.EDGEKIT_POLICY;
  const enabledFlag = process.env.EDGEKIT_ENABLED ?? '0';

  if (!stateDir || !dynamicDir || !policyFile) {
    process.stderr.write('Missing required environment variable(s)\n');
    process.exit(1);
  }

  // When EDGEKIT_ENABLED is not '1', register/unregister/reconcile print 'edgekit disabled' to stderr and exit 3; list still works.
  const isMutatingCommand = ['register', 'unregister', 'reconcile'].includes(command);
  if (isMutatingCommand && enabledFlag !== '1') {
    process.stderr.write('edgekit disabled\n');
    process.exit(3);
  }

  // Load Policy
  let policy: Policy;
  try {
    const rawPolicy = await fs.readFile(policyFile, 'utf8');
    policy = JSON.parse(rawPolicy);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to load policy: ${msg}\n`);
    process.exit(1);
  }

  const store = new FileRouteStore(stateDir);
  const renderer = new TraefikFileRenderer(dynamicDir);
  const quota = new FileQuotaState(stateDir);
  const clock = new RealClock();

  const manager = new RouteManager({
    store,
    renderer,
    quota,
    clock,
    policy,
  });

  try {
    switch (command) {
      case 'register': {
        const owner = typeof flags['owner'] === 'string' ? flags['owner'] : undefined;
        const name = typeof flags['name'] === 'string' ? flags['name'] : undefined;
        const host = typeof flags['host'] === 'string' ? flags['host'] : undefined;
        const target = typeof flags['target'] === 'string' ? flags['target'] : undefined;
        const access = typeof flags['access'] === 'string' ? flags['access'] : undefined;
        const stripPrefix = flags['strip'] === false ? false : true;

        if (!owner || !name || !host || !target) {
          process.stderr.write('register requires --owner, --name, --host, and --target\n');
          process.exit(2);
        }

        const id = deriveId(owner, name);
        const specInput: Record<string, unknown> = {
          id,
          owner,
          host,
          target,
          stripPrefix,
        };
        if (access !== undefined) {
          specInput.access = access;
        }

        const result = await manager.register(specInput);
        process.stdout.write(JSON.stringify(result.spec, null, 2) + '\n');
        process.exit(0);
        break;
      }

      case 'unregister': {
        const id = positionals[0] || (typeof flags['id'] === 'string' ? flags['id'] : undefined);
        if (!id) {
          process.stderr.write('unregister requires an id\n');
          process.exit(2);
        }
        await manager.unregister(id);
        process.exit(0);
        break;
      }

      case 'list': {
        const routes = await manager.list();
        process.stdout.write(JSON.stringify(routes, null, 2) + '\n');
        process.exit(0);
        break;
      }

      case 'reconcile': {
        const res = await manager.reconcile();
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        process.exit(0);
        break;
      }

      default: {
        process.stderr.write(`Unknown command: ${command}\n`);
        process.exit(1);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.startsWith('Validation failed:') ||
      msg.startsWith('Max routes per owner exceeded') ||
      msg.startsWith('Registration rate limit exceeded')
    ) {
      process.stderr.write(`${msg}\n`);
      process.exit(2);
    }

    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
