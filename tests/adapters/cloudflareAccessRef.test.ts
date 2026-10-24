import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareAccessAdapter, appBody, comparablePolicy } from '../../src/adapters/cloudflareAccess.ts';
import { MANAGED_OAUTH_AGENT, runEdgeAccess } from '../../src/cli/edgeCommands.ts';
import type { AccessPolicy } from '../../src/domain/ports.ts';
import { envelope, liveApp, livePolicy } from '../fixtures/cloudflareAccessApi.ts';

const HOST = 'apps.example.com/p/lander--byoa-mcp';
const POLICY: AccessPolicy = { decision: 'allow', include: [{ email: { email: 'operator@example.com' } }] };

interface Call { url: string; method: string; body?: any }

function stub(handler: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { f: f as unknown as typeof fetch, calls };
}
const adapter = (f: typeof fetch) => new CloudflareAccessAdapter({ fetch: f, accountId: 'acc', token: 'tok-secret' });

test('create body matches the API ref: type self_hosted, domain, named inline policy', async () => {
  const { f, calls } = stub((c) =>
    c.method === 'GET' ? { body: envelope([]) } : { body: envelope(liveApp({ aud: 'new-aud' })) });
  const r = await adapter(f).ensure(HOST, 'BYOA MCP', POLICY, { dryRun: false });
  const post = calls.find((c) => c.method === 'POST')!;
  assert.ok(post.url.endsWith('/client/v4/accounts/acc/access/apps'));
  assert.equal(post.body.type, 'self_hosted');
  assert.equal(post.body.domain, HOST);
  assert.equal(post.body.policies[0].name, 'BYOA MCP policy 1');
  assert.equal(post.body.policies[0].decision, 'allow');
  assert.equal(r.aud, 'new-aud');
  assert.equal(r.appId, 'app-id-1');
});

test('idempotent against the live (enriched) policy shape: no PUT, aud returned', async () => {
  const { f, calls } = stub(() => ({ body: envelope([liveApp()]) }));
  const r = await adapter(f).ensure(HOST, 'BYOA MCP', POLICY, { dryRun: false });
  assert.equal(r.changed, false);
  assert.equal(r.aud, 'aud-tag-1');
  assert.deepEqual(calls.filter((c) => c.method !== 'GET'), []);
});

test('policy change on an existing app sends a PUT with type and the new policy', async () => {
  const { f, calls } = stub((c) => (c.method === 'GET' ? { body: envelope([liveApp()]) } : { body: envelope(liveApp()) }));
  const next: AccessPolicy = { decision: 'allow', include: [{ email: { email: 'a@example.com' } }, { email: { email: 'b@example.com' } }] };
  const r = await adapter(f).ensure(HOST, 'BYOA MCP', next, { dryRun: false });
  assert.equal(r.changed, true);
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.ok(put.url.endsWith('/access/apps/app-id-1'));
  assert.equal(put.body.type, 'self_hosted');
  assert.equal(put.body.policies[0].include.length, 2);
});

test('managed OAuth is sent as oauth_configuration, and a missing one on the app triggers an update', async () => {
  const { f, calls } = stub((c) => (c.method === 'GET' ? { body: envelope([liveApp()]) } : { body: envelope(liveApp()) }));
  const r = await runEdgeAccess(adapter(f), HOST, 'BYOA MCP', POLICY, true, MANAGED_OAUTH_AGENT);
  assert.equal(r.changed, true);
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.body.oauth_configuration.enabled, true);
  assert.equal(put.body.oauth_configuration.grant.access_token_lifetime, '15m');
  assert.equal(put.body.oauth_configuration.dynamic_client_registration.enabled, true);
});

test('app already carrying the same OAuth config is left alone', async () => {
  const { f, calls } = stub(() => ({ body: envelope([liveApp({ oauth_configuration: MANAGED_OAUTH_AGENT })]) }));
  const r = await adapter(f).ensure(HOST, 'BYOA MCP', POLICY, { dryRun: false, oauth: MANAGED_OAUTH_AGENT });
  assert.equal(r.changed, false);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});

test('list follows result_info pagination', async () => {
  const { f, calls } = stub((c) => {
    const page = Number(new URL(c.url).searchParams.get('page'));
    const info = (p: number) => ({ page: p, per_page: 50, count: 1, total_count: 2, total_pages: 2 });
    return page === 1
      ? { body: envelope([liveApp({ id: 'a1', domain: 'one.example.com' })], info(1)) }
      : { body: envelope([liveApp({ id: 'a2', domain: HOST })], info(2)) };
  });
  const apps = await adapter(f).list();
  assert.deepEqual(apps.map((a) => a.id), ['a1', 'a2']);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('per_page=50'));
});

test('dry run never mutates, and errors never contain the token', async () => {
  const { f, calls } = stub(() => ({ body: envelope([]) }));
  const r = await adapter(f).ensure(HOST, 'BYOA MCP', POLICY, { dryRun: true });
  assert.equal(r.changed, true);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
  const bad = new CloudflareAccessAdapter({ fetch: (async () => { throw new Error('boom tok-secret'); }) as any, accountId: 'acc', token: 'tok-secret' });
  await assert.rejects(() => bad.list(), (e: Error) => !e.message.includes('tok-secret'));
});

test('comparablePolicy ignores server-added fields; appBody omits oauth when unset', () => {
  assert.equal(comparablePolicy(livePolicy()), comparablePolicy({ decision: 'allow', include: [{ email: { email: 'operator@example.com' } }] }));
  assert.equal('oauth_configuration' in appBody(HOST, 'n', [POLICY]), false);
});
