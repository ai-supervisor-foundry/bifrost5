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
