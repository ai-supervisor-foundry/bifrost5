import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { TraefikFileRenderer } from '../../src/adapters/traefikRenderer.ts';
import { FileRouteStore } from '../../src/adapters/fileStore.ts';
import { FileQuotaState } from '../../src/adapters/fileQuotaState.ts';
import { RouteManager } from '../../src/application/routeManager.ts';
import type { Policy, RouteSpec } from '../../src/domain/routeSpec.ts';
import type { Clock } from '../../src/domain/ports.ts';

class FakeClock implements Clock {
  currentTime: number;
  constructor(initialTime = 1000) {
    this.currentTime = initialTime;
  }
  now(): number {
    return this.currentTime;
  }
}

function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('an unmanaged hand-written .yml survives reconcile', async () => {
  const tmpDir = await createTempDir('ek-reconcile-scope-unmanaged-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });

    const store = new FileRouteStore(stateDir);
    const renderer = new TraefikFileRenderer(dynamicDir);
    const quota = new FileQuotaState(stateDir);
    const clock = new FakeClock();
    const policy: Policy = {
      allowedHosts: ['sites.example.com'],
      ownerCidrs: {
        alice: ['10.20.0.0/16'],
      },
    };

    const manager = new RouteManager({
      store,
      renderer,
      quota,
      clock,
      policy,
    });

    // Write an unmanaged hand-written .yml file in dynamicDir
    const customYmlPath = path.join(dynamicDir, 'custom-handwritten.yml');
    await fs.writeFile(customYmlPath, 'http:\n  routers:\n    custom:\n      rule: Host(`custom.example.com`)\n');

    // Also write a legitimate route via manager
    await manager.register({
      owner: 'alice',
      id: 'alice--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    });

    // Run reconcile
    const result = await manager.reconcile();
    assert.deepEqual(result.removed, []);

    // Verify unmanaged file survived intact
    const content = await fs.readFile(customYmlPath, 'utf8');
    assert.match(content, /custom\.example\.com/);

    // Verify listIds does not include unmanaged file
    const ids = await renderer.listIds();
    assert.deepEqual(ids, ['alice--blog']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('security.yml survives reconcile and is never listed or removed', async () => {
  const tmpDir = await createTempDir('ek-reconcile-scope-security-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });

    const store = new FileRouteStore(stateDir);
    const renderer = new TraefikFileRenderer(dynamicDir);
    const quota = new FileQuotaState(stateDir);
    const clock = new FakeClock();
    const policy: Policy = {
      allowedHosts: ['sites.example.com'],
      ownerCidrs: {
        alice: ['10.20.0.0/16'],
      },
    };

    const manager = new RouteManager({
      store,
      renderer,
      quota,
      clock,
      policy,
    });

    // Write security.yml (without managed marker)
    const securityPath = path.join(dynamicDir, 'security.yml');
    await fs.writeFile(securityPath, 'http:\n  middlewares:\n    edgekit-security:\n      headers:\n        stsSeconds: 31536000\n');

    // Run reconcile
    const result = await manager.reconcile();
    assert.deepEqual(result.removed, []);

    // Verify security.yml still exists
    assert.ok(await fs.stat(securityPath));

    // Verify listIds does not include security
    const ids = await renderer.listIds();
    assert.equal(ids.includes('security'), false);
    assert.equal(ids.includes('security.yml'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('an orphan managed file is removed', async () => {
  const tmpDir = await createTempDir('ek-reconcile-scope-orphan-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });

    const store = new FileRouteStore(stateDir);
    const renderer = new TraefikFileRenderer(dynamicDir);
    const quota = new FileQuotaState(stateDir);
    const clock = new FakeClock();
    const policy: Policy = {
      allowedHosts: ['sites.example.com'],
      ownerCidrs: {
        alice: ['10.20.0.0/16'],
      },
    };

    const manager = new RouteManager({
      store,
      renderer,
      quota,
      clock,
      policy,
    });

    // Write a managed route file directly to dynamicDir without storing in desired store
    const orphanPath = path.join(dynamicDir, 'alice--orphan.yml');
    await fs.writeFile(orphanPath, '# managed-by: edgekit\nhttp:\n  routers:\n    alice--orphan:\n      rule: Host(`sites.example.com`)\n');

    const idsBefore = await renderer.listIds();
    assert.deepEqual(idsBefore, ['alice--orphan']);

    // Run reconcile
    const result = await manager.reconcile();
    assert.deepEqual(result.removed, ['alice--orphan']);

    // Verify orphan was removed from disk
    await assert.rejects(fs.stat(orphanPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('a stored spec whose owner became reserved is skipped and reported', async () => {
  const tmpDir = await createTempDir('ek-reconcile-scope-reserved-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });

    const store = new FileRouteStore(stateDir);
    const renderer = new TraefikFileRenderer(dynamicDir);
    const quota = new FileQuotaState(stateDir);
    const clock = new FakeClock();

    // Initial policy where 'legacy' is allowed
    const initialPolicy: Policy = {
      allowedHosts: ['sites.example.com'],
      ownerCidrs: {
        alice: ['10.20.0.0/16'],
        legacy: ['10.20.0.0/16'],
      },
    };

    const manager1 = new RouteManager({
      store,
      renderer,
      quota,
      clock,
      policy: initialPolicy,
    });

    // Register alice route and legacy route
    await manager1.register({
      owner: 'alice',
      id: 'alice--app',
      host: 'sites.example.com',
      target: 'http://10.20.0.1:3000',
    });
    await manager1.register({
      owner: 'legacy',
      id: 'legacy--tool',
      host: 'sites.example.com',
      target: 'http://10.20.0.2:3000',
    });

    // Now operator updates policy so 'legacy' is in reservedOwners
    const updatedPolicy: Policy = {
      reservedOwners: ['legacy'],
      allowedHosts: ['sites.example.com'],
      ownerCidrs: {
        alice: ['10.20.0.0/16'],
      },
    };

    const manager2 = new RouteManager({
      store,
      renderer,
      quota,
      clock,
      policy: updatedPolicy,
    });

    // Remove legacy route from renderer to test if reconcile attempts to render it
    await renderer.remove('legacy--tool');

    // Reconcile with updated policy
    const result = await manager2.reconcile();

    // Stored spec whose owner became reserved is skipped and reported, not rendered, not thrown
    assert.ok(result.skipped);
    const legacySkipped = result.skipped?.find(s => s.id === 'legacy--tool');
    assert.ok(legacySkipped);
    assert.ok(legacySkipped?.errors.some(e => e.includes("reserved pattern 'legacy'")));

    // legacy--tool must not have been rendered
    const dynamicIds = await renderer.listIds();
    assert.equal(dynamicIds.includes('legacy--tool'), false);
    assert.equal(result.written.includes('legacy--tool'), false);

    // alice--app remains intact
    assert.equal(dynamicIds.includes('alice--app'), true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('second reconcile is a no-op', async () => {
  const tmpDir = await createTempDir('ek-reconcile-scope-noop-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });

    const store = new FileRouteStore(stateDir);
    const renderer = new TraefikFileRenderer(dynamicDir);
    const quota = new FileQuotaState(stateDir);
    const clock = new FakeClock();
    const policy: Policy = {
      allowedHosts: ['sites.example.com'],
      ownerCidrs: {
        alice: ['10.20.0.0/16'],
      },
    };

    const manager = new RouteManager({
      store,
      renderer,
      quota,
      clock,
      policy,
    });

    // Register a route
    await manager.register({
      owner: 'alice',
      id: 'alice--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    });

    // Plant an unmanaged hand-written file
    const unmanagedPath = path.join(dynamicDir, 'manual-rules.yml');
    await fs.writeFile(unmanagedPath, 'http:\n  routers:\n    manual:\n      rule: Host(`manual.example.com`)\n');

    // First reconcile
    const res1 = await manager.reconcile();
    assert.deepEqual(res1.written, []);
    assert.deepEqual(res1.removed, []);

    // Second reconcile
    const res2 = await manager.reconcile();
    assert.deepEqual(res2.written, []);
    assert.deepEqual(res2.removed, []);

    // Unmanaged file still survives
    assert.ok(await fs.stat(unmanagedPath));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('renderer write refuses to overwrite unmanaged file and remove checks isValidId', async () => {
  const tmpDir = await createTempDir('ek-renderer-safety-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    // Create an unmanaged file with matching route name
    const unmanagedPath = path.join(tmpDir, 'alice--existing.yml');
    await fs.writeFile(unmanagedPath, '# handwritten config\nhttp:\n  routers: {}\n');

    const spec: RouteSpec = {
      id: 'alice--existing',
      owner: 'alice',
      host: 'sites.example.com',
      pathPrefix: '/p/alice--existing/',
      target: 'http://10.20.0.5:3000',
      access: 'private',
      stripPrefix: true,
    };

    // write() refuses to overwrite unmanaged file and errors
    await assert.rejects(
      () => renderer.write(spec),
      /Refusing to overwrite unmanaged file/
    );

    // remove(id) calls isValidId and throws on invalid id before building path
    await assert.rejects(
      () => renderer.remove('invalid--id--too--many'),
      /Invalid id/
    );
    await assert.rejects(
      () => renderer.remove('../escape'),
      /Invalid id/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
