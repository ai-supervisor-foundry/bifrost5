import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRoutes } from '../../src/application/targetCheck.ts';

const routes = [{ id: 'alice--blog', target: 'http://10.20.0.5:3000' }];

function resp(status: number, headers: Record<string, string> = {}): Response {
  return new Response('x', { status, headers });
}

test('check fails when target serves notfound fingerprint', async () => {
  let calls = 0;
  const res = await checkRoutes(routes, async () => {
    calls++;
    return resp(404, { 'x-edgekit-notfound': '1' });
  });
  assert.equal(res[0].ok, false);
  assert.match(res[0].reason ?? '', /notfound/);
  assert.equal(calls, 1);
});

test('check does not act on one 5xx', async () => {
  const seq = [resp(502), resp(200)];
  const res = await checkRoutes(routes, async () => seq.shift()!);
  assert.equal(res[0].ok, true);
});

test('check fails on persistent 5xx and no answer, passes plain 404', async () => {
  const bad = await checkRoutes(routes, async () => resp(503), { retries: 2 });
  assert.equal(bad[0].ok, false);
  const down = await checkRoutes(routes, async () => { throw new Error('ECONNREFUSED'); }, { retries: 1 });
  assert.equal(down[0].ok, false);
  const ok = await checkRoutes(routes, async () => resp(404));
  assert.equal(ok[0].ok, true);
});

test('check resolves alias target before probing', async () => {
  const urls: string[] = [];
  const res = await checkRoutes(
    [{ id: 'apps--lander', target: 'http://lander-web-apps:80' }],
    async (url) => {
      urls.push(url);
      return resp(200);
    },
    { resolveHost: async (host) => (host === 'lander-web-apps' ? ['172.20.0.7'] : []) }
  );
  assert.deepEqual(urls, ['http://172.20.0.7:80/']);
  assert.equal(res[0].ok, true);
  assert.equal(res[0].target, 'http://lander-web-apps:80');
});

test('check does not resolve IPv4 literal targets', async () => {
  const urls: string[] = [];
  let resolved = 0;
  await checkRoutes(routes, async (url) => { urls.push(url); return resp(200); }, {
    resolveHost: async () => { resolved++; return []; },
  });
  assert.equal(resolved, 0);
  assert.deepEqual(urls, ['http://10.20.0.5:3000/']);
});

test('check fails when alias resolves to two containers', async () => {
  let calls = 0;
  const res = await checkRoutes(
    [{ id: 'apps--lander', target: 'http://lander-web-apps:80' }],
    async () => { calls++; return resp(200); },
    { resolveHost: async () => ['172.20.0.7', '172.20.0.8'] }
  );
  assert.equal(res[0].ok, false);
  assert.match(res[0].reason ?? '', /2 containers/);
  assert.equal(res[0].target, 'http://lander-web-apps:80');
  assert.equal(calls, 0);
});

test('check fails when alias is unresolvable', async () => {
  let calls = 0;
  const res = await checkRoutes(
    [{ id: 'apps--lander', target: 'http://lander-web-apps:80' }],
    async () => { calls++; return resp(200); },
    { resolveHost: async () => [] }
  );
  assert.equal(res[0].ok, false);
  assert.match(res[0].reason ?? '', /no container/);
  assert.equal(calls, 0);
});
