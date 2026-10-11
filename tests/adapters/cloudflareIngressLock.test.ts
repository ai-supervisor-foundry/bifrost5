import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { CloudflareTunnelIngressAdapter } from '../../src/adapters/cloudflareIngress.ts';

function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ACCOUNT_ID = 'acc-lock';
const TUNNEL_ID = 'tun-lock';
const TOKEN = 'lock-test-token';

/**
 * A fake fetch backed by shared mutable "remote" state, with an artificial
 * delay on GET so two concurrent addHost calls have a real window to race
 * over the ingress snapshot unless serialized by the lock.
 *
 * `putCountAtEachGetStart` records, for every GET, how many PUTs had already
 * landed at the moment that GET began. This is a causal-order check rather
 * than a wall-clock one: if the lock truly serializes read-merge-write, the
 * second GET can only start once the first PUT has already completed, so
 * the recorded sequence must be strictly non-decreasing (e.g. [0, 1]). Without
 * the lock both GETs can start before either PUT lands, giving [0, 0] and a
 * lost update — independent of how the event loop happens to schedule timers.
 */
function createSharedRemote(initialIngress: any[], getDelayMs: number) {
  let stored = initialIngress;
  const putBodies: any[] = [];
  const putCountAtEachGetStart: number[] = [];

  const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method || 'GET';
    if (method === 'GET') {
      putCountAtEachGetStart.push(putBodies.length);
      await sleep(getDelayMs);
      return new Response(
        JSON.stringify({ result: { config: { ingress: stored } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body));
      putBodies.push(body);
      stored = body.config.ingress;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  return { fakeFetch, getStored: () => stored, putBodies, putCountAtEachGetStart };
}

test('concurrent addHost calls serialize through the lock: both hosts survive', async () => {
  const tmpDir = await createTempDir('ek-ingress-lock-');
  try {
    const lockFilePath = path.join(tmpDir, 'ingress.lock');
    const initialIngress = [{ service: 'http_status:404' }];
    const { fakeFetch, getStored, putCountAtEachGetStart } = createSharedRemote(initialIngress, 25);

    const adapterA = new CloudflareTunnelIngressAdapter({
      fetch: fakeFetch as any,
      accountId: ACCOUNT_ID,
      tunnelId: TUNNEL_ID,
      token: TOKEN,
      lockFilePath,
    });
    const adapterB = new CloudflareTunnelIngressAdapter({
      fetch: fakeFetch as any,
      accountId: ACCOUNT_ID,
      tunnelId: TUNNEL_ID,
      token: TOKEN,
      lockFilePath,
    });

    const [resA, resB] = await Promise.all([
      adapterA.addHost('a.example.com', 'http://10.0.0.1:8080', { dryRun: false }),
      adapterB.addHost('b.example.com', 'http://10.0.0.2:8080', { dryRun: false }),
    ]);

    assert.equal(resA.changed, true);
    assert.equal(resB.changed, true);

    // Causal proof the lock serialized the two calls: the second GET only
    // started after the first PUT had already landed.
    assert.deepEqual(putCountAtEachGetStart, [0, 1]);

    const final = getStored();
    const hostnames = final.map((r: any) => r.hostname).filter(Boolean);
    assert.ok(hostnames.includes('a.example.com'), 'lost update: a.example.com missing');
    assert.ok(hostnames.includes('b.example.com'), 'lost update: b.example.com missing');
    assert.deepEqual(final[final.length - 1], { service: 'http_status:404' });

    // Lock must be released after both operations complete.
    await assert.rejects(fs.access(lockFilePath), /ENOENT/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('a stale lock file is reclaimed instead of blocking forever', async () => {
  const tmpDir = await createTempDir('ek-ingress-stale-');
  try {
    const lockFilePath = path.join(tmpDir, 'ingress.lock');
    // Simulate an abandoned lock from a crashed process: old mtime, foreign token.
    await fs.writeFile(lockFilePath, 'dead-token:99999:0', 'utf8');
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(lockFilePath, oldTime, oldTime);

    const initialIngress = [{ service: 'http_status:404' }];
    const { fakeFetch, getStored } = createSharedRemote(initialIngress, 0);

    const adapter = new CloudflareTunnelIngressAdapter({
      fetch: fakeFetch as any,
      accountId: ACCOUNT_ID,
      tunnelId: TUNNEL_ID,
      token: TOKEN,
      lockFilePath,
      lockStaleMs: 1_000,
      lockTimeoutMs: 2_000,
      lockPollIntervalMs: 10,
    });

    const start = Date.now();
    const res = await adapter.addHost('new.example.com', 'http://10.0.0.5:8080', { dryRun: false });
    const elapsed = Date.now() - start;

    assert.equal(res.changed, true);
    assert.ok(elapsed < 1_900, `expected stale lock reclaim well before timeout, took ${elapsed}ms`);
    assert.ok(getStored().some((r: any) => r.hostname === 'new.example.com'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('dry-run diff is a real line diff: only changed lines carry +/- markers', async () => {
  const tmpDir = await createTempDir('ek-ingress-diff-');
  try {
    const lockFilePath = path.join(tmpDir, 'ingress.lock');
    const initialIngress = [
      { hostname: 'first.example.com', service: 'http://10.0.0.1:8080' },
      { service: 'http_status:404' },
    ];
    const { fakeFetch } = createSharedRemote(initialIngress, 0);

    const adapter = new CloudflareTunnelIngressAdapter({
      fetch: fakeFetch as any,
      accountId: ACCOUNT_ID,
      tunnelId: TUNNEL_ID,
      token: TOKEN,
      lockFilePath,
    });

    const result = await adapter.addHost('second.example.com', 'http://10.0.0.2:8080', { dryRun: true });
    assert.equal(result.changed, true);

    const lines = result.diff.split('\n');
    assert.equal(lines[0], '--- current');
    assert.equal(lines[1], '+++ updated');

    const bodyLines = lines.slice(2);
    assert.ok(bodyLines.length > 0);
    // Every body line must be a changed line: '+' additions or '-' removals only.
    for (const line of bodyLines) {
      assert.match(line, /^[+-]/, `unchanged line leaked into diff: ${line}`);
    }
    // The untouched catch-all rule's lines must not appear as changed lines.
    assert.ok(!bodyLines.some((l) => l.includes('http_status:404')));
    // The new host must appear as an addition.
    assert.ok(bodyLines.some((l) => l.startsWith('+') && l.includes('second.example.com')));
    // The pre-existing host is untouched and must not show as removed/re-added.
    assert.ok(!bodyLines.some((l) => l.includes('first.example.com')));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('GET failure aborts without PUT and releases the lock for the next caller', async () => {
  const tmpDir = await createTempDir('ek-ingress-getfail-');
  try {
    const lockFilePath = path.join(tmpDir, 'ingress.lock');
    let putCount = 0;
    const failingFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method || 'GET';
      if (method === 'GET') {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500, statusText: 'Internal Server Error' });
      }
      putCount++;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const adapter = new CloudflareTunnelIngressAdapter({
      fetch: failingFetch as any,
      accountId: ACCOUNT_ID,
      tunnelId: TUNNEL_ID,
      token: TOKEN,
      lockFilePath,
    });

    await assert.rejects(
      adapter.addHost('x.example.com', 'http://10.0.0.1:8080', { dryRun: false }),
      /Failed to GET tunnel configuration: HTTP 500/
    );
    assert.equal(putCount, 0);

    // Lock released despite the abort; a follow-up call must not hang.
    const { fakeFetch, getStored } = createSharedRemote([{ service: 'http_status:404' }], 0);
    const adapter2 = new CloudflareTunnelIngressAdapter({
      fetch: fakeFetch as any,
      accountId: ACCOUNT_ID,
      tunnelId: TUNNEL_ID,
      token: TOKEN,
      lockFilePath,
      lockTimeoutMs: 500,
    });
    const res = await adapter2.addHost('y.example.com', 'http://10.0.0.2:8080', { dryRun: false });
    assert.equal(res.changed, true);
    assert.ok(getStored().some((r: any) => r.hostname === 'y.example.com'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
