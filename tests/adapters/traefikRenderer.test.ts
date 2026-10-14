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

    const parsed: any = parse(renderedBytes.toString('utf8'));
    const ruleString: string = parsed.http.routers['alice--blog'].rule;
    assert.equal(ruleString.includes('/p/alice--blog/'), true, 'Rule must contain /p/alice--blog/ with trailing slash');
    assert.equal(ruleString.includes('PathPrefix(`/p/alice--blog`)'), false, 'Rule must never contain bare PathPrefix(`/p/alice--blog`)');
    assert.equal(ruleString.includes('Path(`/p/alice--blog`)'), false, 'Main router must not also match the bare Path');
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
    assert.deepEqual(Object.keys(parsed.http.middlewares), ['slash-carol--api']);
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
    await fs.writeFile(path.join(tmpDir, 'alice--blog.yml'), '# managed-by: edgekit\ncontent');
    await fs.writeFile(path.join(tmpDir, 'bob--app.yml'), '# managed-by: edgekit\ncontent');
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

test('output parses back with yaml and has exactly one main router plus its bare-path router', async () => {
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
    assert.equal(routerKeys.length, 2);
    assert.deepEqual(routerKeys, ['alice--blog', 'alice--blog-bare']);

    assert.ok(parsed.http.services);
    const serviceKeys = Object.keys(parsed.http.services);
    assert.equal(serviceKeys.length, 1);
    assert.equal(serviceKeys[0], 'alice--blog');
    assert.equal(parsed.http.services['alice--blog'].loadBalancer.servers[0].url, 'http://10.20.0.5:3000');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('bare-path router <id>-bare exists, redirects via redirectRegex, and uses noop@internal as its service', async () => {
  const tmpDir = await createTempDir('ek-renderer-bare-');
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

    const bareRouter = parsed.http.routers['alice--blog-bare'];
    assert.ok(bareRouter, 'bare router alice--blog-bare must exist');
    assert.equal(bareRouter.rule, 'Host(`sites.example.com`) && Path(`/p/alice--blog`)');
    assert.equal(bareRouter.service, 'noop@internal', 'bare router must not get its own service');
    assert.deepEqual(bareRouter.middlewares, ['edgekit-security@file', 'slash-alice--blog']);
    assert.equal(bareRouter.middlewares[0], 'edgekit-security@file', 'edgekit-security@file must be first in the chain');

    const redirectMw = parsed.http.middlewares['slash-alice--blog'];
    assert.ok(redirectMw, 'slash-alice--blog middleware must exist');
    assert.deepEqual(redirectMw.redirectRegex, {
      regex: '^https?://[^/]+/p/alice--blog$',
      replacement: '/p/alice--blog/',
      permanent: false,
    });
    assert.equal(
      redirectMw.redirectRegex.replacement,
      '/p/alice--blog/',
      'replacement must be the bare relative path, no scheme or host'
    );
    assert.equal(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(redirectMw.redirectRegex.replacement),
      false,
      'replacement must not contain a scheme'
    );

    // No service named "alice--blog-bare" or similar should be added for the redirect router.
    assert.equal(parsed.http.services['alice--blog-bare'], undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('main router matches only the slash-prefixed path, not the bare path', async () => {
  const tmpDir = await createTempDir('ek-renderer-mainonly-');
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

    const mainRouter = parsed.http.routers['alice--blog'];
    assert.equal(mainRouter.rule, 'Host(`sites.example.com`) && PathPrefix(`/p/alice--blog/`)');
    assert.equal(mainRouter.rule.includes('Path(`/p/alice--blog`)'), false, 'main router must not also match the bare path');
    assert.equal(mainRouter.rule.includes('||'), false, 'main router rule should no longer be an OR of two path matches');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ids containing -- are escaped correctly in the redirect regex', async () => {
  const tmpDir = await createTempDir('ek-renderer-regexid-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const spec: RouteSpec = {
      id: 'multiword--multi-part-name',
      owner: 'multiword',
      host: 'sites.example.com',
      pathPrefix: '/p/multiword--multi-part-name/',
      target: 'http://10.20.0.6:3000',
      access: 'public',
      stripPrefix: false,
    };

    await renderer.write(spec);

    const content = await fs.readFile(path.join(tmpDir, 'multiword--multi-part-name.yml'), 'utf8');
    const parsed: any = parse(content);

    const redirectMw = parsed.http.middlewares['slash-multiword--multi-part-name'];
    assert.ok(redirectMw, 'slash middleware for an id containing -- must exist');
    assert.equal(
      redirectMw.redirectRegex.regex,
      '^https?://[^/]+/p/multiword--multi-part-name$',
      'the -- separator must appear literally, unescaped, in the compiled regex'
    );
    assert.equal(
      redirectMw.redirectRegex.replacement,
      '/p/multiword--multi-part-name/',
      'replacement must be the bare relative path, no scheme or host, even when the id contains --'
    );
    assert.equal(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(redirectMw.redirectRegex.replacement),
      false,
      'replacement must not contain a scheme'
    );

    const bareRouter = parsed.http.routers['multiword--multi-part-name-bare'];
    assert.equal(bareRouter.rule, 'Host(`sites.example.com`) && Path(`/p/multiword--multi-part-name`)');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
