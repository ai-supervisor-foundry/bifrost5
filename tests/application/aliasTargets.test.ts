import test from 'node:test';
import assert from 'node:assert/strict';

import type { RouteSpec, Policy } from '../../src/domain/routeSpec.ts';
import type {
  RouteStorePort,
  RouteRenderPort,
  QuotaStatePort,
  Clock,
  TargetResolverPort,
  ResolvedTarget,
} from '../../src/domain/ports.ts';
import { RouteManager } from '../../src/application/routeManager.ts';

class Store implements RouteStorePort {
  routes = new Map<string, RouteSpec>();
  put(s: RouteSpec) { this.routes.set(s.id, s); }
  get(id: string) { return this.routes.get(id) ?? null; }
  list() { return [...this.routes.values()]; }
  delete(id: string) { return this.routes.delete(id); }
}
class Renderer implements RouteRenderPort {
  rendered = new Map<string, RouteSpec>();
  writeCalls: string[] = [];
  removeCalls: string[] = [];
  write(s: RouteSpec) { this.writeCalls.push(s.id); this.rendered.set(s.id, s); }
  remove(id: string) { this.removeCalls.push(id); return this.rendered.delete(id); }
  listIds() { return [...this.rendered.keys()]; }
}
class Quota implements QuotaStatePort {
  recordRegistration() {}
  countInWindow() { return 0; }
}
const clock: Clock = { now: () => 1000 };

const policy: Policy = {
  allowedHosts: ['sites.example.com'],
  ownerCidrs: { alice: ['10.20.0.0/16'] },
  ownerTargets: { alice: ['blog-app'] },
};

function make(resolved: ResolvedTarget[] | Error, pol: Policy = policy) {
  const store = new Store();
  const renderer = new Renderer();
  const resolver: TargetResolverPort = {
    async resolve() {
      if (resolved instanceof Error) throw resolved;
      return resolved;
    },
  };
  const manager = new RouteManager({
    store, renderer, quota: new Quota(), clock, policy: pol, resolver, aliasTargets: true,
  });
  return { manager, store, renderer };
}

const input = {
  owner: 'alice', id: 'alice--blog', host: 'sites.example.com', target: 'http://blog-app:3000',
};

function seeded(resolved: ResolvedTarget[] | Error, pol: Policy = policy) {
  const m = make(resolved, pol);
  const spec = {
    id: 'alice--blog', owner: 'alice', host: 'sites.example.com', pathPrefix: '/p/alice--blog/',
    target: 'http://blog-app:3000', access: 'private', stripPrefix: true,
  } as RouteSpec;
  m.store.put(spec);
  m.renderer.rendered.set(spec.id, spec);
  return m;
}

test('register accepts alias resolving to one app container', async () => {
  const { manager, store } = make([{ ip: '10.20.0.5', container: 'blog-app' }]);
  const r = await manager.register(input);
  assert.equal(r.spec.target, 'http://blog-app:3000');
  assert.ok(store.get('alice--blog'));
});

test('register rejects unresolvable alias', async () => {
  const { manager, store } = make([]);
  await assert.rejects(() => manager.register(input), /Validation failed: .*resolve/);
  assert.equal(store.list().length, 0);
});

test('reconcile keeps existing file when alias is unresolvable', async () => {
  const { manager, renderer } = seeded([]);
  const res = await manager.reconcile();
  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.written, []);
  assert.equal(res.skipped?.[0]?.id, 'alice--blog');
  assert.ok(renderer.rendered.has('alice--blog'));
});

test('reconcile rejects alias with two containers', async () => {
  const { manager, renderer } = seeded([
    { ip: '10.20.0.5', container: 'blog-app' },
    { ip: '10.20.0.6', container: 'blog-app-2' },
  ]);
  const res = await manager.reconcile();
  assert.equal(res.skipped?.[0]?.id, 'alice--blog');
  assert.match(res.skipped![0].errors.join(' '), /exactly one/);
  assert.deepEqual(res.removed, []);
  assert.ok(renderer.rendered.has('alice--blog'));
});

test('reconcile keeps existing file when alias resolves to kit container', async () => {
  const { manager, renderer } = seeded([{ ip: '10.20.0.5', container: 'edgekit-traefik-1' }]);
  const res = await manager.reconcile();
  assert.equal(res.skipped?.[0]?.id, 'alice--blog');
  assert.deepEqual(res.removed, []);
  assert.ok(renderer.rendered.has('alice--blog'));
});

test('reconcile keeps existing file when alias hits denyIps', async () => {
  const { manager, renderer } = seeded(
    [{ ip: '10.20.0.5', container: 'blog-app' }],
    { ...policy, denyIps: ['10.20.0.0/24'] }
  );
  const res = await manager.reconcile();
  assert.equal(res.skipped?.[0]?.id, 'alice--blog');
  assert.deepEqual(res.removed, []);
  assert.ok(renderer.rendered.has('alice--blog'));
});
