import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { RouteSpec } from '../domain/routeSpec.ts';
import type { RouteStorePort } from '../domain/ports.ts';

export async function atomicWrite(targetPath: string, contents: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });

  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(dir, `.tmp-${Date.now()}-${randomSuffix}.tmp`);

  const fileHandle = await fs.open(tempPath, 'w');
  try {
    await fileHandle.writeFile(contents, 'utf8');
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  await fs.rename(tempPath, targetPath);
}

export type OnCorruptCallback = (filePath: string, error: unknown) => void;

export class FileRouteStore implements RouteStorePort {
  private stateDir: string;
  private onCorrupt?: OnCorruptCallback;

  constructor(stateDir: string, onCorrupt?: OnCorruptCallback) {
    this.stateDir = stateDir;
    this.onCorrupt = onCorrupt;
  }

  private getDesiredDir(): string {
    return path.join(this.stateDir, 'desired');
  }

  private getSpecPath(owner: string, id: string): string {
    return path.join(this.getDesiredDir(), owner, `${id}.json`);
  }

  async put(spec: RouteSpec): Promise<void> {
    const targetPath = this.getSpecPath(spec.owner, spec.id);
    const contents = JSON.stringify(spec, null, 2);
    await atomicWrite(targetPath, contents);
  }

  async get(id: string): Promise<RouteSpec | null> {
    const doubleDashIdx = id.indexOf('--');
    if (doubleDashIdx > 0) {
      const owner = id.slice(0, doubleDashIdx);
      const directPath = this.getSpecPath(owner, id);
      try {
        const content = await fs.readFile(directPath, 'utf8');
        const parsed = JSON.parse(content) as RouteSpec;
        return parsed;
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
          // Fall through to search in case owner doesn't match directory
        } else if (err instanceof SyntaxError) {
          if (this.onCorrupt) {
            this.onCorrupt(directPath, err);
          }
          return null;
        } else {
          throw err;
        }
      }
    }

    // Fallback: search across all owner directories
    const all = await this.list();
    const found = all.find((s) => s.id === id);
    return found ?? null;
  }

  async list(): Promise<RouteSpec[]> {
    const desiredDir = this.getDesiredDir();
    const results: RouteSpec[] = [];

    let ownerEntries: fsSync.Dirent[];
    try {
      ownerEntries = await fs.readdir(desiredDir, { withFileTypes: true });
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    for (const ownerEntry of ownerEntries) {
      if (!ownerEntry.isDirectory()) {
        continue;
      }
      const ownerDir = path.join(desiredDir, ownerEntry.name);
      let fileEntries: fsSync.Dirent[];
      try {
        fileEntries = await fs.readdir(ownerDir, { withFileTypes: true });
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
          continue;
        }
        throw err;
      }

      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile()) {
          continue;
        }
        // ignore *.tmp files
        if (fileEntry.name.endsWith('.tmp')) {
          continue;
        }
        if (!fileEntry.name.endsWith('.json')) {
          continue;
        }

        const filePath = path.join(ownerDir, fileEntry.name);
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          const parsed = JSON.parse(raw) as RouteSpec;
          results.push(parsed);
        } catch (err: unknown) {
          if (err instanceof SyntaxError) {
            if (this.onCorrupt) {
              this.onCorrupt(filePath, err);
            }
            continue;
          }
          throw err;
        }
      }
    }

    return results;
  }

  async delete(id: string): Promise<boolean> {
    const doubleDashIdx = id.indexOf('--');
    if (doubleDashIdx > 0) {
      const owner = id.slice(0, doubleDashIdx);
      const directPath = this.getSpecPath(owner, id);
      try {
        await fs.unlink(directPath);
        return true;
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
          // May be stored elsewhere, search all
        } else {
          throw err;
        }
      }
    }

    // Fallback: search and remove if found anywhere
    const desiredDir = this.getDesiredDir();
    try {
      const ownerEntries = await fs.readdir(desiredDir, { withFileTypes: true });
      for (const ownerEntry of ownerEntries) {
        if (!ownerEntry.isDirectory()) continue;
        const candidate = path.join(desiredDir, ownerEntry.name, `${id}.json`);
        try {
          await fs.unlink(candidate);
          return true;
        } catch (err: unknown) {
          const nodeErr = err as NodeJS.ErrnoException;
          if (nodeErr.code !== 'ENOENT') {
            throw err;
          }
        }
      }
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return false;
      }
      throw err;
    }

    return false;
  }
}
