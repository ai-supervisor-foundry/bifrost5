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

test('site route renders expected rule and middlewares', async () => {
  const tmpDir = await createTempDir('ek-site-render-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const spec: RouteSpec = {
      id: 'alice--control',
      owner: 'alice',
      host: 'site.example.com',
      pathPrefix: '/control',
      target: 'http://10.20.0.5:3000',
      access: 'private',
      stripPrefix: false,
      kind: 'site',
    };

    await renderer.write(spec);

    const content = await fs.readFile(path.join(tmpDir, 'alice--control.yml'), 'utf8');
    const parsed: any = parse(content);

    assert.ok(parsed.http);
    assert.ok(parsed.http.routers);

    const router = parsed.http.routers['alice--control'];
    assert.ok(router, 'main site router alice--control must exist');
    assert.equal(router.rule, 'Host(`site.example.com`) && PathPrefix(`/control`)');
    assert.equal(router.service, 'alice--control');
    assert.deepEqual(router.middlewares, [
      'edgekit-security@file',
      'edgekit-access-jwt@file',
    ]);

    // Site route without redirect option has no secondary router
    assert.equal(parsed.http.routers['alice--control-bare'], undefined);
    assert.equal(parsed.http.routers['alice--control-redirect'], undefined);

    // Services
    assert.ok(parsed.http.services['alice--control']);
    assert.equal(parsed.http.services['alice--control'].loadBalancer.servers[0].url, 'http://10.20.0.5:3000');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('site route with public access omits access-jwt middleware and keeps edgekit-security@file first', async () => {
  const tmpDir = await createTempDir('ek-site-pub-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const spec: RouteSpec = {
      id: 'bob--portal',
      owner: 'bob',
      host: 'site.example.com',
      pathPrefix: '/',
      target: 'http://10.30.0.5:8080',
      access: 'public',
      stripPrefix: false,
      kind: 'site',
    };

    await renderer.write(spec);

    const content = await fs.readFile(path.join(tmpDir, 'bob--portal.yml'), 'utf8');
    const parsed: any = parse(content);

    const router = parsed.http.routers['bob--portal'];
    assert.equal(router.rule, 'Host(`site.example.com`) && PathPrefix(`/`)');
    assert.deepEqual(router.middlewares, ['edgekit-security@file']);
    assert.equal(router.middlewares.includes('edgekit-access-jwt@file'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('site route with stripPrefix: true renders stripPrefix middleware', async () => {
  const tmpDir = await createTempDir('ek-site-strip-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const spec: RouteSpec = {
      id: 'alice--api',
      owner: 'alice',
      host: 'site.example.com',
      pathPrefix: '/api',
      target: 'http://10.20.0.5:3000',
      access: 'private',
      stripPrefix: true,
      kind: 'site',
    };

    await renderer.write(spec);

    const content = await fs.readFile(path.join(tmpDir, 'alice--api.yml'), 'utf8');
    const parsed: any = parse(content);

    const router = parsed.http.routers['alice--api'];
    assert.deepEqual(router.middlewares, [
      'edgekit-security@file',
      'strip-alice--api',
      'edgekit-access-jwt@file',
    ]);

    const stripMw = parsed.http.middlewares['strip-alice--api'];
    assert.ok(stripMw);
    assert.deepEqual(stripMw.stripPrefix.prefixes, ['/api']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('redirect renders router with Path(<from>) exact, priority 100, and redirectRegex with relative Location', async () => {
  const tmpDir = await createTempDir('ek-site-redirect-');
  try {
    const renderer = new TraefikFileRenderer(tmpDir);

    const spec: RouteSpec = {
      id: 'alice--app',
      owner: 'alice',
      host: 'site.example.com',
      pathPrefix: '/app',
      target: 'http://10.20.0.5:3000',
      access: 'public',
      stripPrefix: false,
      kind: 'site',
      redirectExactFrom: '/',
      redirectTo: '/app/',
    };

    await renderer.write(spec);

    const content = await fs.readFile(path.join(tmpDir, 'alice--app.yml'), 'utf8');
    const parsed: any = parse(content);

    // Prefix router
    const prefixRouter = parsed.http.routers['alice--app'];
    assert.ok(prefixRouter);
    assert.equal(prefixRouter.rule, 'Host(`site.example.com`) && PathPrefix(`/app`)');

    // Redirect router
    const redirectRouter = parsed.http.routers['alice--app-redirect'];
    assert.ok(redirectRouter, 'redirect router alice--app-redirect must exist');
    assert.equal(redirectRouter.rule, 'Host(`site.example.com`) && Path(`/`)');
    assert.equal(redirectRouter.priority, 100, 'redirect router must have higher priority (100) than prefix route');
    assert.equal(redirectRouter.service, 'noop@internal');
    assert.deepEqual(redirectRouter.middlewares, ['edgekit-security@file', 'redirect-alice--app']);

    // Middleware redirectRegex
    const redirectMw = parsed.http.middlewares['redirect-alice--app'];
    assert.ok(redirectMw);
    assert.deepEqual(redirectMw.redirectRegex, {
      regex: '^https?://[^/]+/?$',
      replacement: '/app/',
      permanent: false,
    });
    assert.equal(redirectMw.redirectRegex.replacement.startsWith('/'), true, 'replacement must be a relative Location');
    assert.equal(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(redirectMw.redirectRegex.replacement),
      false,
      'replacement must not contain a scheme'
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('existing /p routes render byte-for-byte as before', async () => {
  const tmpDir = await createTempDir('ek-site-p-golden-');
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
      `Existing /p route rendered YAML does not match golden file byte-for-byte.\nRendered:\n${renderedBytes.toString('utf8')}\nGolden:\n${goldenBytes.toString('utf8')}`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
