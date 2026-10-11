import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { atomicWrite, FileRouteStore } from '../../src/adapters/fileStore.ts';
import { FileQuotaState } from '../../src/adapters/fileQuotaState.ts';
import type { RouteSpec } from '../../src/domain/routeSpec.ts';

function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('round-trip put / get / list / delete in FileRouteStore', async () => {
  const tmpDir = await createTempDir('ek-store-test-');
  try {
    const store = new FileRouteStore(tmpDir);

    const spec1: RouteSpec = {
      id: 'alice--app',
      owner: 'alice',
      host: 'sites.example.com',
      pathPrefix: '/p/alice--app/',
      target: 'http://10.20.0.1:3000',
      access: 'private',
      stripPrefix: true,
    };

    const spec2: RouteSpec = {
      id: 'bob--web',
      owner: 'bob',
      host: 'sites.example.com',
      pathPrefix: '/p/bob--web/',
      target: 'http://10.30.0.1:8080',
      access: 'public',
      stripPrefix: false,
    };

    // 1. Initial get returns null
    assert.equal(await store.get('alice--app'), null);
    assert.deepEqual(await store.list(), []);

    // 2. Put specs
    await store.put(spec1);
    await store.put(spec2);

    // Verify file exists on disk at <stateDir>/desired/<owner>/<id>.json
    const spec1Path = path.join(tmpDir, 'desired', 'alice', 'alice--app.json');
    const spec1Raw = await fs.readFile(spec1Path, 'utf8');
    assert.deepEqual(JSON.parse(spec1Raw), spec1);

    // 3. Get specs
    const retrieved1 = await store.get('alice--app');
    assert.deepEqual(retrieved1, spec1);
    const retrieved2 = await store.get('bob--web');
    assert.deepEqual(retrieved2, spec2);

    // 4. List specs
    const list = await store.list();
    assert.equal(list.length, 2);
    const ids = list.map((s) => s.id).sort();
    assert.deepEqual(ids, ['alice--app', 'bob--web']);

    // 5. Delete spec
    const deleted = await store.delete('alice--app');
    assert.equal(deleted, true);
    assert.equal(await store.get('alice--app'), null);

    // Deleting again returns false
    const deletedAgain = await store.delete('alice--app');
    assert.equal(deletedAgain, false);

    // List has only spec2
    const remaining = await store.list();
    assert.equal(remaining.length, 1);
    assert.deepEqual(remaining[0], spec2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('atomicWrite leaves no .tmp behind and temp files never end in .yml/.yaml/.json', async () => {
  const tmpDir = await createTempDir('ek-atomic-test-');
  try {
    const targetFile = path.join(tmpDir, 'nested', 'target.json');
    await atomicWrite(targetFile, JSON.stringify({ hello: 'world' }));

    // Target exists with correct content
    const content = await fs.readFile(targetFile, 'utf8');
    assert.deepEqual(JSON.parse(content), { hello: 'world' });

    // Check directory for any .tmp files
    const parentDir = path.dirname(targetFile);
    const files = await fs.readdir(parentDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0, 'No .tmp files should remain');

    // Ensure no files end in forbidden extensions other than target.json
    for (const file of files) {
      if (file !== 'target.json') {
        assert.equal(file.endsWith('.json'), false);
        assert.equal(file.endsWith('.yml'), false);
        assert.equal(file.endsWith('.yaml'), false);
      }
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('atomicWrite removes its temp file when the rename fails', async () => {
  const tmpDir = await createTempDir('ek-atomic-fail-');
  try {
    const targetDir = path.join(tmpDir, 'blocked');
    await fs.mkdir(targetDir);

    await assert.rejects(atomicWrite(targetDir, '{"x":1}'));

    const files = await fs.readdir(tmpDir);
    assert.deepEqual(files, ['blocked']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('atomicWrite never exposes a partial file while concurrent reader loops', async () => {
  const tmpDir = await createTempDir('ek-concurrent-test-');
  try {
    const targetFile = path.join(tmpDir, 'large.json');

    // Create a large payload (e.g. 10,000 array elements)
    const largeObject = {
      numbers: Array.from({ length: 10000 }, (_, i) => i),
      text: 'a'.repeat(50000),
      timestamp: Date.now(),
    };
    const jsonString = JSON.stringify(largeObject);

    // Initial write
    await atomicWrite(targetFile, jsonString);

    let stopReading = false;
    let readCount = 0;
    let corruptedReads = 0;

    // Concurrent reader loop
    const readerPromise = (async () => {
      while (!stopReading) {
        try {
          const data = await fs.readFile(targetFile, 'utf8');
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed.numbers) || parsed.numbers.length !== 10000) {
            corruptedReads++;
          }
          readCount++;
        } catch {
          corruptedReads++;
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    // Perform multiple atomic writes concurrently
    for (let i = 0; i < 20; i++) {
      const updated = {
        ...largeObject,
        iteration: i,
      };
      await atomicWrite(targetFile, JSON.stringify(updated));
    }

    stopReading = true;
    await readerPromise;

    assert.ok(readCount > 0, 'Reader should have performed multiple reads');
    assert.equal(corruptedReads, 0, 'Reader should never observe a partial or corrupt file');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('list() ignores *.tmp files and skips corrupt JSON while reporting via onCorrupt callback', async () => {
  const tmpDir = await createTempDir('ek-corrupt-test-');
  try {
    const corruptReports: { path: string; error: unknown }[] = [];
    const store = new FileRouteStore(tmpDir, (filePath, err) => {
      corruptReports.push({ path: filePath, error: err });
    });

    const validSpec: RouteSpec = {
      id: 'alice--valid',
      owner: 'alice',
      host: 'sites.example.com',
      pathPrefix: '/p/alice--valid/',
      target: 'http://10.20.0.1:3000',
      access: 'private',
      stripPrefix: true,
    };

    await store.put(validSpec);

    // Manually place a corrupt JSON file in alice dir
    const corruptPath = path.join(tmpDir, 'desired', 'alice', 'alice--corrupt.json');
    await fs.writeFile(corruptPath, '{ broken json: [');

    // Manually place a stray .tmp file in alice dir
    const tmpFilePath = path.join(tmpDir, 'desired', 'alice', 'stray.tmp');
    await fs.writeFile(tmpFilePath, 'temporary unfinished data');

    // List should not throw, should ignore .tmp, skip corrupt, and return validSpec
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], validSpec);

    // Check onCorrupt callback was called for corrupt file
    assert.equal(corruptReports.length, 1);
    assert.equal(corruptReports[0].path, corruptPath);
    assert.ok(corruptReports[0].error instanceof SyntaxError);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('quota counts persist across new FileQuotaState instances and prune entries older than largest window', async () => {
  const tmpDir = await createTempDir('ek-quota-test-');
  try {
    const quota1 = new FileQuotaState(tmpDir);

    const baseTime = 1000000;
    // Record registrations
    await quota1.recordRegistration('alice', baseTime);
    await quota1.recordRegistration('alice', baseTime + 1000);
    await quota1.recordRegistration('alice', baseTime + 2000);
    await quota1.recordRegistration('bob', baseTime + 2500);

    // Verify count in window (querying 3000ms first sets largest window to 3000ms)
    assert.equal(await quota1.countInWindow('alice', 3000, baseTime + 2000), 3); // entries at 0, +1000, +2000
    assert.equal(await quota1.countInWindow('alice', 1500, baseTime + 2000), 2); // entries at +1000, +2000
    assert.equal(await quota1.countInWindow('bob', 3000, baseTime + 2500), 1);

    // Create a new FileQuotaState instance pointing to same stateDir
    const quota2 = new FileQuotaState(tmpDir);

    // Verify state persisted across new instance
    assert.equal(await quota2.countInWindow('alice', 3000, baseTime + 2000), 3);
    assert.equal(await quota2.countInWindow('alice', 1500, baseTime + 2000), 2);
    assert.equal(await quota2.countInWindow('bob', 3000, baseTime + 2500), 1);

    // Test pruning: use a window and record at a later time
    // Let window be 5000 ms
    await quota2.countInWindow('alice', 5000, baseTime + 2000);
    // Now record at baseTime + 20000 with quota3 having default largest window 5000
    const quota3 = new FileQuotaState(tmpDir, 5000);
    await quota3.recordRegistration('alice', baseTime + 20000);

    // The old entries from baseTime (0, 1000, 2000) are older than (baseTime + 20000 - 5000)
    // and should be pruned
    assert.equal(await quota3.countInWindow('alice', 5000, baseTime + 20000), 1);
    assert.equal(await quota3.countInWindow('bob', 5000, baseTime + 20000), 0);

    // Verify on disk in quota.json
    const rawQuota = await fs.readFile(path.join(tmpDir, 'state', 'quota.json'), 'utf8');
    const parsedQuota = JSON.parse(rawQuota);
    assert.equal(parsedQuota.entries.length, 1);
    assert.equal(parsedQuota.entries[0].nowMs, baseTime + 20000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('FileRouteStore handles concurrent put operations cleanly', async () => {
  const tmpDir = await createTempDir('ek-concurrent-put-');
  try {
    const store = new FileRouteStore(tmpDir);

    const puts = Array.from({ length: 15 }, (_, i) => {
      const spec: RouteSpec = {
        id: `alice--route${i}`,
        owner: 'alice',
        host: 'sites.example.com',
        pathPrefix: `/p/alice--route${i}/`,
        target: `http://10.20.0.${i}:3000`,
        access: 'private',
        stripPrefix: true,
      };
      return store.put(spec);
    });

    await Promise.all(puts);

    const list = await store.list();
    assert.equal(list.length, 15);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('FileQuotaState handles concurrent registrations cleanly', async () => {
  const tmpDir = await createTempDir('ek-concurrent-quota-');
  try {
    const quota = new FileQuotaState(tmpDir);
    const now = 500000;

    const registrations = Array.from({ length: 20 }, (_, i) => {
      return quota.recordRegistration('alice', now + i);
    });

    await Promise.all(registrations);

    const count = await quota.countInWindow('alice', 1000, now + 50);
    assert.equal(count, 20);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
