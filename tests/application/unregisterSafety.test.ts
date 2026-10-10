import test from 'node:test';
import assert from 'node:assert/strict';

import type { RouteSpec, Policy } from '../../src/domain/routeSpec.ts';
import type { RouteStorePort, RouteRenderPort, QuotaStatePort, Clock } from '../../src/domain/ports.ts';
import { RouteManager } from '../../src/application/routeManager.ts';

class FakeRouteStore implements RouteStorePort {
  routes: Map<string, RouteSpec> = new Map();
  putCalls: RouteSpec[] = [];
  deleteCalls: string[] = [];

  put(spec: RouteSpec): void {
    this.putCalls.push(spec);
    this.routes.set(spec.id, spec);
  }

  get(id: string): RouteSpec | null {
    return this.routes.get(id) ?? null;
  }

  list(): RouteSpec[] {
    return Array.from(this.routes.values());
  }

  delete(id: string): boolean {
    this.deleteCalls.push(id);
    return this.routes.delete(id);
  }
}

class FakeRouteRenderer implements RouteRenderPort {
  rendered: Map<string, RouteSpec> = new Map();
  writeCalls: RouteSpec[] = [];
  removeCalls: string[] = [];

  write(spec: RouteSpec): void {
    this.writeCalls.push(spec);
    this.rendered.set(spec.id, spec);
  }

  remove(id: string): boolean {
    this.removeCalls.push(id);
    return this.rendered.delete(id);
  }

  listIds(): string[] {
    return Array.from(this.rendered.keys());
  }
}

class FakeQuotaState implements QuotaStatePort {
  records: { owner: string; timestamp: number }[] = [];

  recordRegistration(owner: string, nowMs: number): void {
    this.records.push({ owner, timestamp: nowMs });
  }

  countInWindow(owner: string, windowMs: number, nowMs: number): number {
    const windowStart = nowMs - windowMs;
    return this.records.filter(r => r.owner === owner && r.timestamp >= windowStart && r.timestamp <= nowMs).length;
  }
}

class FakeClock implements Clock {
  currentTime: number;

  constructor(initialTime = 1000) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  advance(ms: number): void {
    this.currentTime += ms;
  }
}

const defaultPolicy: Policy = {
  allowedHosts: ['sites.example.com'],
  ownerCidrs: {
    alice: ['10.20.0.0/16'],
  },
};

function createManager() {
  const store = new FakeRouteStore();
  const renderer = new FakeRouteRenderer();
  const quota = new FakeQuotaState();
  const clock = new FakeClock();

  const manager = new RouteManager({
    store,
    renderer,
    quota,
    clock,
    policy: defaultPolicy,
  });

  return { manager, store, renderer, quota, clock };
}

test('unregister rejects invalid id without calling store.delete or renderer.remove', async () => {
  const invalidIds = ['security', '../../x', 'a/b'];

  for (const id of invalidIds) {
    const { manager, store, renderer } = createManager();

    await assert.rejects(
      async () => {
        await manager.unregister(id);
      },
      (err: Error) => {
        assert.match(err.message, /Validation failed/);
        return true;
      }
    );

    assert.equal(store.deleteCalls.length, 0, `store.delete should not be called for invalid id: ${id}`);
    assert.equal(renderer.removeCalls.length, 0, `renderer.remove should not be called for invalid id: ${id}`);
  }
});

test('unregister with valid id works and second unregister is a no-op', async () => {
  const { manager, store, renderer } = createManager();

  await manager.register({
    owner: 'alice',
    id: 'alice--blog',
    host: 'sites.example.com',
    target: 'http://10.20.0.5:3000',
  });

  assert.equal(store.get('alice--blog') !== null, true);
  assert.equal(renderer.listIds().includes('alice--blog'), true);

  // First unregister
  const unreg1 = await manager.unregister('alice--blog');
  assert.equal(unreg1, true);
  assert.equal(store.deleteCalls.length, 1);
  assert.equal(renderer.removeCalls.length, 1);
  assert.equal(store.get('alice--blog'), null);
  assert.equal(renderer.listIds().includes('alice--blog'), false);

  // Second unregister is a no-op
  const unreg2 = await manager.unregister('alice--blog');
  assert.equal(unreg2, true);
  assert.equal(store.deleteCalls.length, 2);
  assert.equal(renderer.removeCalls.length, 2);
  assert.equal(store.get('alice--blog'), null);
  assert.equal(renderer.listIds().includes('alice--blog'), false);
});
