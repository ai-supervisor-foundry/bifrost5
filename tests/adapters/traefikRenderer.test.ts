import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { parse } from 'yaml';
import { TraefikFileRenderer } from '../../src/adapters/traefikRenderer.ts';
import type { RouteSpec } from '../../src/domain/routeSpec.ts';

function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('golden test: render alice--blog spec matches tests/golden/alice--blog.yml byte-for-byte', async () => {
  const tmpDir = await createTempDir('ek-renderer-golden-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const spec: RouteSpec = {
      id: 'alice--blog',
      owner: 'alice',
      host: 'sites.example.com',
      pathPrefix: '/p/alice--blog/',
      target: 'http://10.20.0.5:3000',
      access: 'private',
      stripPrefix: true,
    };

    await renderer.write(spec);

    const renderedFile = path.join(tmpDir, 'alice--blog.yml');
    const renderedBytes = await fs.readFile(renderedFile);

    const goldenFile = path.join(process.cwd(), 'tests/golden/alice--blog.yml');
    const goldenBytes = await fs.readFile(goldenFile);

    assert.equal(
      renderedBytes.equals(goldenBytes),
      true,
      `Rendered YAML does not match golden file byte-for-byte.\nRendered:\n${renderedBytes.toString('utf8')}\nGolden:\n${goldenBytes.toString('utf8')}`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('public route has no access-jwt middleware and security is always first', async () => {
  const tmpDir = await createTempDir('ek-renderer-public-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const publicSpec: RouteSpec = {
      id: 'bob--landing',
      owner: 'bob',
      host: 'sites.example.com',
      pathPrefix: '/p/bob--landing/',
      target: 'http://10.30.0.1:8080',
      access: 'public',
      stripPrefix: true,
    };

    await renderer.write(publicSpec);

    const renderedContent = await fs.readFile(path.join(tmpDir, 'bob--landing.yml'), 'utf8');
    const parsed: any = parse(renderedContent);

    const middlewares = parsed.http.routers['bob--landing'].middlewares;
    assert.deepEqual(middlewares, [
      'edgekit-security@file',
      'strip-bob--landing',
    ]);
    assert.equal(middlewares[0], 'edgekit-security@file');
    assert.equal(middlewares.includes('edgekit-access-jwt@file'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('route without stripPrefix does not include strip middleware', async () => {
  const tmpDir = await createTempDir('ek-renderer-nostrip-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const spec: RouteSpec = {
      id: 'carol--api',
      owner: 'carol',
      host: 'api.example.com',
      pathPrefix: '/p/carol--api/',
      target: 'http://10.40.0.2:4000',
      access: 'private',
      stripPrefix: false,
    };

    await renderer.write(spec);

    const renderedContent = await fs.readFile(path.join(tmpDir, 'carol--api.yml'), 'utf8');
    const parsed: any = parse(renderedContent);

    const middlewares = parsed.http.routers['carol--api'].middlewares;
    assert.deepEqual(middlewares, [
      'edgekit-security@file',
      'edgekit-access-jwt@file',
    ]);
    assert.equal(parsed.http.middlewares, undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('hostile host throws defensively', async () => {
  const tmpDir = await createTempDir('ek-renderer-hostile-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const hostileHosts = [
      'example.com`backtick',
      'example.com;rm -rf',
      'example.com/path',
      'example.com:8080',
      'EXAMPLE.COM',
      'example$.com',
      'example_test.com',
      '',
    ];

    for (const host of hostileHosts) {
      const spec: RouteSpec = {
        id: 'alice--blog',
        owner: 'alice',
        host,
        pathPrefix: '/p/alice--blog/',
        target: 'http://10.20.0.5:3000',
        access: 'private',
        stripPrefix: true,
      };

      await assert.rejects(
        () => renderer.write(spec),
        /Invalid host/,
        `Expected rejection for host: ${host}`
      );
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('invalid id not matching <owner>--<name> throws defensively', async () => {
  const tmpDir = await createTempDir('ek-renderer-id-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const invalidIds = [
      'alice',
      'alice-blog',
      '--blog',
      'alice--',
      'alice--bob--name',
      'alice/blog',
      '',
    ];

    for (const id of invalidIds) {
      const spec: RouteSpec = {
        id,
        owner: 'alice',
        host: 'sites.example.com',
        pathPrefix: '/p/test/',
        target: 'http://10.20.0.5:3000',
        access: 'private',
        stripPrefix: true,
      };

      await assert.rejects(
        () => renderer.write(spec),
        /Invalid id/,
        `Expected rejection for id: ${id}`
      );
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('listIds lists ids ignoring security.yml and .tmp files', async () => {
  const tmpDir = await createTempDir('ek-renderer-list-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    // Seed directory with various files
    await fs.writeFile(path.join(tmpDir, 'security.yml'), 'security: true');
    await fs.writeFile(path.join(tmpDir, 'alice--blog.yml'), 'content');
    await fs.writeFile(path.join(tmpDir, 'bob--app.yml'), 'content');
    await fs.writeFile(path.join(tmpDir, 'pending.tmp'), 'temp');
    await fs.writeFile(path.join(tmpDir, '.tmp-123.tmp'), 'temp');
    await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'notes');

    const ids = await renderer.listIds();
    assert.deepEqual(ids, ['alice--blog', 'bob--app']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('remove(id) deletes <id>.yml and is idempotent', async () => {
  const tmpDir = await createTempDir('ek-renderer-remove-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const spec: RouteSpec = {
      id: 'alice--blog',
      owner: 'alice',
      host: 'sites.example.com',
      pathPrefix: '/p/alice--blog/',
      target: 'http://10.20.0.5:3000',
      access: 'private',
      stripPrefix: true,
    };

    await renderer.write(spec);
    assert.equal(await fs.stat(path.join(tmpDir, 'alice--blog.yml')).then(() => true).catch(() => false), true);

    const removedFirst = await renderer.remove('alice--blog');
    assert.equal(removedFirst, true);
    assert.equal(await fs.stat(path.join(tmpDir, 'alice--blog.yml')).then(() => true).catch(() => false), false);

    // Idempotent: removing again returns false and does not throw
    const removedSecond = await renderer.remove('alice--blog');
    assert.equal(removedSecond, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('output parses back with yaml and has exactly one router', async () => {
  const tmpDir = await createTempDir('ek-renderer-parse-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const spec: RouteSpec = {
      id: 'alice--blog',
      owner: 'alice',
      host: 'sites.example.com',
      pathPrefix: '/p/alice--blog/',
      target: 'http://10.20.0.5:3000',
      access: 'private',
      stripPrefix: true,
    };

    await renderer.write(spec);

    const content = await fs.readFile(path.join(tmpDir, 'alice--blog.yml'), 'utf8');
    const parsed: any = parse(content);

    assert.ok(parsed);
    assert.ok(parsed.http);
    assert.ok(parsed.http.routers);

    const routerKeys = Object.keys(parsed.http.routers);
    assert.equal(routerKeys.length, 1);
    assert.equal(routerKeys[0], 'alice--blog');

    assert.ok(parsed.http.services);
    const serviceKeys = Object.keys(parsed.http.services);
    assert.equal(serviceKeys.length, 1);
    assert.equal(serviceKeys[0], 'alice--blog');
    assert.equal(parsed.http.services['alice--blog'].loadBalancer.servers[0].url, 'http://10.20.0.5:3000');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
