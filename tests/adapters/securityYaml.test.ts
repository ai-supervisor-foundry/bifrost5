import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';

test('security.yml defines scanner-blocking router, blackhole service, and keeps existing middlewares', async () => {
  const filePath = path.join(process.cwd(), 'dynamic/security.yml');
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = parse(content);

  assert.ok(parsed, 'YAML content should parse');
  assert.ok(parsed.http, 'http section must exist');

  // Assert router exists with priority 1000
  const router = parsed.http.routers?.['edgekit-probe-block'];
  assert.ok(router, 'edgekit-probe-block router must exist');
  assert.equal(router.priority, 1000, 'router priority must be 1000');
  assert.deepEqual(router.entryPoints, ['web'], 'router entryPoints must include web');
  assert.deepEqual(router.middlewares, ['edgekit-security'], 'router middlewares must be edgekit-security');
  assert.equal(router.service, 'edgekit-blackhole', 'router service must be edgekit-blackhole');

  // Assert its rule contains each of the nine prefixes
  const expectedPrefixes = [
    '/.env',
    '/.git',
    '/vendor/phpunit',
    '/cgi-bin',
    '/wp-admin',
    '/wp-login.php',
    '/phpunit',
    '/actuator',
    '/server-status',
  ];

  const rule = router.rule;
  assert.ok(typeof rule === 'string', 'router rule must be a string');

  for (const prefix of expectedPrefixes) {
    const expectedPattern = `PathPrefix(\`${prefix}\`)`;
    assert.ok(
      rule.includes(expectedPattern),
      `router rule must contain ${expectedPattern}`
    );
  }

  // Assert service exists
  const service = parsed.http.services?.['edgekit-blackhole'];
  assert.ok(service, 'edgekit-blackhole service must exist');
  assert.deepEqual(service.loadBalancer?.servers, [{ url: 'http://127.0.0.1:9' }], 'service loadBalancer servers must point to http://127.0.0.1:9');

  // Assert edgekit-security and edgekit-access-jwt middlewares still exist
  const middlewares = parsed.http.middlewares;
  assert.ok(middlewares, 'middlewares must exist');
  assert.ok(middlewares['edgekit-security'], 'edgekit-security middleware must still exist');
  assert.ok(middlewares['edgekit-access-jwt'], 'edgekit-access-jwt middleware must still exist');

  // The security chain is exactly headers then rate limit, and each child exists as its own middleware
  const chain = middlewares['edgekit-security'].chain?.middlewares;
  assert.deepEqual(chain, ['edgekit-security-headers', 'edgekit-security-ratelimit'], 'edgekit-security chain must be exactly headers then ratelimit');
  for (const child of chain) {
    assert.ok(middlewares[child], `chain child ${child} must exist as a middleware`);
  }
});
