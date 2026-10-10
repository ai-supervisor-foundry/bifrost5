import test from 'node:test';
import assert from 'node:assert/strict';

import type { RouteSpec, Policy } from '../../src/domain/routeSpec.ts';
import type { RouteStorePort, RouteRenderPort, QuotaStatePort, Clock } from '../../src/domain/ports.ts';
import { RouteManager } from '../../src/application/routeManager.ts';

// In-memory fakes
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
    bob: ['10.30.0.0/16'],
  },
  publicOwners: ['bob'],
};

function createManager(options?: {
  limits?: { maxRoutesPerOwner?: number; maxRegistrationsPerWindow?: number; windowMs?: number };
  policy?: Policy;
  clock?: FakeClock;
}) {
  const store = new FakeRouteStore();
  const renderer = new FakeRouteRenderer();
  const quota = new FakeQuotaState();
  const clock = options?.clock ?? new FakeClock(1000);
  const policy = options?.policy ?? defaultPolicy;

  const manager = new RouteManager(
    { store, renderer, quota, clock, policy },
    options?.limits
  );

  return { manager, store, renderer, quota, clock, policy };
}

test('1. register twice with identical spec gives same result without consuming quota or duplicate writes', async () => {
  const { manager, store, renderer, quota } = createManager();
  const input = {
    owner: 'alice',
    id: 'alice--blog',
    host: 'sites.example.com',
    target: 'http://10.20.0.5:3000',
  };

  const res1 = await manager.register(input);
  assert.equal(res1.ok, true);
  assert.equal(res1.spec.id, 'alice--blog');
  assert.equal(store.putCalls.length, 1);
  assert.equal(renderer.writeCalls.length, 1);
  assert.equal(quota.records.length, 1);

  // Register identical spec again
  const res2 = await manager.register(input);
  assert.equal(res2.ok, true);
  assert.deepEqual(res1.spec, res2.spec);

  // Does NOT consume rate-limit quota and does not duplicate
  assert.equal(store.putCalls.length, 1, 'store.put should not be called again');
  assert.equal(renderer.writeCalls.length, 1, 'renderer.write should not be called again');
  assert.equal(quota.records.length, 1, 'quota should not be consumed again');
});

test('2. updating an existing route with different spec succeeds, consumes quota and overwrites store and renderer', async () => {
  const { manager, store, renderer, quota } = createManager();
  const input1 = {
    owner: 'alice',
    id: 'alice--blog',
    host: 'sites.example.com',
    target: 'http://10.20.0.5:3000',
  };
  const input2 = {
    owner: 'alice',
    id: 'alice--blog',
    host: 'sites.example.com',
    target: 'http://10.20.0.6:4000',
  };

  await manager.register(input1);
  assert.equal(store.putCalls.length, 1);
  assert.equal(quota.records.length, 1);

  const res2 = await manager.register(input2);
  assert.equal(res2.ok, true);
  assert.equal(res2.spec.target, 'http://10.20.0.6:4000');
  assert.equal(store.putCalls.length, 2);
  assert.equal(renderer.writeCalls.length, 2);
  assert.equal(quota.records.length, 2);
});

test('3. per-owner route cap hit: rejects new route when maxRoutesPerOwner is reached', async () => {
  const { manager, store, renderer } = createManager({
    limits: { maxRoutesPerOwner: 2, maxRegistrationsPerWindow: 10, windowMs: 60000 },
  });

  await manager.register({
    owner: 'alice',
    id: 'alice--r1',
    host: 'sites.example.com',
    target: 'http://10.20.0.1:3000',
  });
  await manager.register({
    owner: 'alice',
    id: 'alice--r2',
    host: 'sites.example.com',
    target: 'http://10.20.0.2:3000',
  });

  // Attempting 3rd route should fail
  await assert.rejects(
    async () => {
      await manager.register({
        owner: 'alice',
        id: 'alice--r3',
        host: 'sites.example.com',
        target: 'http://10.20.0.3:3000',
      });
    },
    (err: Error) => {
      assert.match(err.message, /Max routes per owner exceeded/);
      return true;
    }
  );

  // Store and renderer still only have 2
  assert.equal((await manager.list()).length, 2);
  assert.equal(store.putCalls.length, 2);
  assert.equal(renderer.writeCalls.length, 2);
});

test('4. rate limit hit then allowed after the window passes', async () => {
  const clock = new FakeClock(1000);
  const { manager, quota } = createManager({
    limits: { maxRoutesPerOwner: 10, maxRegistrationsPerWindow: 2, windowMs: 5000 },
    clock,
  });

  // 1st reg
  await manager.register({
    owner: 'alice',
    id: 'alice--r1',
    host: 'sites.example.com',
    target: 'http://10.20.0.1:3000',
  });
  // 2nd reg
  await manager.register({
    owner: 'alice',
    id: 'alice--r2',
    host: 'sites.example.com',
    target: 'http://10.20.0.2:3000',
  });

  // 3rd reg within window fails
  await assert.rejects(
    async () => {
      await manager.register({
        owner: 'alice',
        id: 'alice--r3',
        host: 'sites.example.com',
        target: 'http://10.20.0.3:3000',
      });
    },
    (err: Error) => {
      assert.match(err.message, /Registration rate limit exceeded/);
      return true;
    }
  );

  // Advance time beyond window
  clock.advance(5001);

  // Now 3rd reg succeeds
  const res = await manager.register({
    owner: 'alice',
    id: 'alice--r3',
    host: 'sites.example.com',
    target: 'http://10.20.0.3:3000',
  });
  assert.equal(res.ok, true);
  assert.equal(quota.records.length, 3);
});

test('5. reserved id or invalid spec never reaches store or renderer', async () => {
  const { manager, store, renderer, quota } = createManager();

  // Invalid spec (reserved owner)
  await assert.rejects(
    async () => {
      await manager.register({
        owner: 'admin',
        id: 'admin--app',
        host: 'sites.example.com',
        target: 'http://10.20.0.1:3000',
      });
    },
    (err: Error) => {
      assert.match(err.message, /Validation failed/);
      return true;
    }
  );

  // Invalid spec (target outside CIDR)
  await assert.rejects(
    async () => {
      await manager.register({
        owner: 'alice',
        id: 'alice--badip',
        host: 'sites.example.com',
        target: 'http://192.168.1.1:3000',
      });
    },
    (err: Error) => {
      assert.match(err.message, /Validation failed/);
      return true;
    }
  );

  // Zero calls to store, renderer, quota
  assert.equal(store.putCalls.length, 0);
  assert.equal(renderer.writeCalls.length, 0);
  assert.equal(quota.records.length, 0);
});

test('6. unregister removes from store and renderer and is idempotent', async () => {
  const { manager, store, renderer } = createManager();

  await manager.register({
    owner: 'alice',
    id: 'alice--r1',
    host: 'sites.example.com',
    target: 'http://10.20.0.1:3000',
  });

  assert.equal(await store.get('alice--r1') !== null, true);
  assert.equal(renderer.listIds().includes('alice--r1'), true);

  // Unregister once
  const unreg1 = await manager.unregister('alice--r1');
  assert.equal(unreg1, true);
  assert.equal(await store.get('alice--r1'), null);
  assert.equal(renderer.listIds().includes('alice--r1'), false);

  // Unregister second time (idempotent)
  const unreg2 = await manager.unregister('alice--r1');
  assert.equal(unreg2, true);
  assert.equal(await store.get('alice--r1'), null);
  assert.equal(renderer.listIds().includes('alice--r1'), false);
});

test('7. list returns all specs from store', async () => {
  const { manager } = createManager();

  await manager.register({
    owner: 'alice',
    id: 'alice--r1',
    host: 'sites.example.com',
    target: 'http://10.20.0.1:3000',
  });
  await manager.register({
    owner: 'bob',
    id: 'bob--r2',
    host: 'sites.example.com',
    target: 'http://10.30.0.2:3000',
  });

  const list = await manager.list();
  assert.equal(list.length, 2);
  const ids = list.map(r => r.id).sort();
  assert.deepEqual(ids, ['alice--r1', 'bob--r2']);
});

test('8. reconcile removes orphans and rewrites missing routes, and running twice changes nothing the second time', async () => {
  const { manager, store, renderer } = createManager();

  // Register r1 properly
  await manager.register({
    owner: 'alice',
    id: 'alice--r1',
    host: 'sites.example.com',
    target: 'http://10.20.0.1:3000',
  });

  // Directly insert r2 into store only (simulating missing route file in renderer)
  const specR2: RouteSpec = {
    id: 'alice--r2',
    owner: 'alice',
    host: 'sites.example.com',
    pathPrefix: '/p/alice--r2/',
    target: 'http://10.20.0.2:3000',
    access: 'private',
    stripPrefix: true,
  };
  await store.put(specR2);

  // Directly insert orphan into renderer (not in store)
  const orphanSpec: RouteSpec = {
    id: 'ghost--orphan',
    owner: 'ghost',
    host: 'sites.example.com',
    pathPrefix: '/p/ghost--orphan/',
    target: 'http://10.20.0.99:3000',
    access: 'private',
    stripPrefix: true,
  };
  await renderer.write(orphanSpec);

  // Check state before reconcile
  assert.deepEqual(renderer.listIds().sort(), ['alice--r1', 'ghost--orphan']);

  // First reconcile
  const res1 = await manager.reconcile();
  assert.deepEqual(res1.written, ['alice--r2']);
  assert.deepEqual(res1.removed, ['ghost--orphan']);
  assert.deepEqual(renderer.listIds().sort(), ['alice--r1', 'alice--r2']);

  // Second reconcile (idempotent, changes nothing)
  const res2 = await manager.reconcile();
  assert.deepEqual(res2.written, []);
  assert.deepEqual(res2.removed, []);
  assert.deepEqual(renderer.listIds().sort(), ['alice--r1', 'alice--r2']);
});

test('9. default limits: allows up to 20 routes per owner and 10 registrations per window', async () => {
  const { manager } = createManager(); // default limits

  // Register 10 routes for alice within window
  for (let i = 1; i <= 10; i++) {
    await manager.register({
      owner: 'alice',
      id: `alice--r${i}`,
      host: 'sites.example.com',
      target: 'http://10.20.0.1:3000',
    });
  }

  // 11th registration in same window should fail rate limit
  await assert.rejects(
    async () => {
      await manager.register({
        owner: 'alice',
        id: 'alice--r11',
        host: 'sites.example.com',
        target: 'http://10.20.0.1:3000',
      });
    },
    (err: Error) => {
      assert.match(err.message, /Registration rate limit exceeded/);
      return true;
    }
  );
});

test('10. on success store.put is called before renderer.write', async () => {
  const { manager, store, renderer } = createManager();
  const callOrder: string[] = [];

  const originalStorePut = store.put.bind(store);
  store.put = (spec: RouteSpec) => {
    callOrder.push('store.put');
    originalStorePut(spec);
  };

  const originalRendererWrite = renderer.write.bind(renderer);
  renderer.write = (spec: RouteSpec) => {
    callOrder.push('renderer.write');
    originalRendererWrite(spec);
  };

  await manager.register({
    owner: 'alice',
    id: 'alice--order',
    host: 'sites.example.com',
    target: 'http://10.20.0.1:3000',
  });

  assert.deepEqual(callOrder, ['store.put', 'renderer.write']);
});
