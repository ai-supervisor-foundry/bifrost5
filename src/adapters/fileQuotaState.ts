import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { QuotaStatePort } from '../domain/ports.ts';
import { atomicWrite } from './fileStore.ts';

interface RegistrationEntry {
  owner: string;
  nowMs: number;
}

interface QuotaPersistedData {
  entries: RegistrationEntry[];
  largestWindowMs?: number;
}

export class FileQuotaState implements QuotaStatePort {
  private stateDir: string;
  private quotaFilePath: string;
  private largestWindowMs: number;
  private mutex: Promise<void> = Promise.resolve();

  constructor(stateDir: string, defaultLargestWindowMs: number = 0) {
    this.stateDir = stateDir;
    this.quotaFilePath = path.join(this.stateDir, 'state', 'quota.json');
    this.largestWindowMs = defaultLargestWindowMs;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release: () => void = () => {};
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  private async loadData(): Promise<QuotaPersistedData> {
    try {
      const raw = await fs.readFile(this.quotaFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return {
          entries: parsed,
          largestWindowMs: this.largestWindowMs,
        };
      }
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        largestWindowMs:
          typeof parsed.largestWindowMs === 'number'
            ? Math.max(parsed.largestWindowMs, this.largestWindowMs)
            : this.largestWindowMs,
      };
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return {
          entries: [],
          largestWindowMs: this.largestWindowMs,
        };
      }
      if (err instanceof SyntaxError) {
        return {
          entries: [],
          largestWindowMs: this.largestWindowMs,
        };
      }
      throw err;
    }
  }

  private async saveData(data: QuotaPersistedData): Promise<void> {
    const contents = JSON.stringify(data, null, 2);
    await atomicWrite(this.quotaFilePath, contents);
  }

  async recordRegistration(owner: string, nowMs: number): Promise<void> {
    return this.withLock(async () => {
      const data = await this.loadData();
      if (data.largestWindowMs && data.largestWindowMs > this.largestWindowMs) {
        this.largestWindowMs = data.largestWindowMs;
      }
      data.entries.push({ owner, nowMs });

      // Prune entries older than the largest window used (if a window has been used)
      if (this.largestWindowMs > 0) {
        const pruneCutoff = nowMs - this.largestWindowMs;
        data.entries = data.entries.filter((e) => e.nowMs >= pruneCutoff);
      }
      data.largestWindowMs = this.largestWindowMs;

      await this.saveData(data);
    });
  }

  async countInWindow(owner: string, windowMs: number, nowMs: number): Promise<number> {
    return this.withLock(async () => {
      if (windowMs > this.largestWindowMs) {
        this.largestWindowMs = windowMs;
      }
      const data = await this.loadData();
      if (data.largestWindowMs && data.largestWindowMs > this.largestWindowMs) {
        this.largestWindowMs = data.largestWindowMs;
      }

      // Prune entries older than the largest window used (relative to newest entry recorded)
      const originalCount = data.entries.length;
      if (this.largestWindowMs > 0 && data.entries.length > 0) {
        const latestRecordedTime = Math.max(...data.entries.map((e) => e.nowMs));
        const pruneCutoff = Math.max(nowMs, latestRecordedTime) - this.largestWindowMs;
        data.entries = data.entries.filter((e) => e.nowMs >= pruneCutoff);
      }
      data.largestWindowMs = this.largestWindowMs;

      if (data.entries.length !== originalCount) {
        await this.saveData(data);
      }

      const cutoff = nowMs - windowMs;
      let count = 0;
      for (const entry of data.entries) {
        if (entry.owner === owner && entry.nowMs >= cutoff && entry.nowMs <= nowMs) {
          count++;
        }
      }
      return count;
    });
  }
}
