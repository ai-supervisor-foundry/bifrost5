import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { parse } from 'yaml';
import { createVerifierServer, type Jwks, type JwksFetcher } from '../../src/verifier/server.ts';

// This file is the README "Hardening checklist" made executable: each test
// parses the one file that is supposed to enforce a given control, so a
// control and its enforcing file cannot drift apart silently.

async function readText(relPath: string): Promise<string> {
  return fs.readFile(path.resolve(process.cwd(), relPath), 'utf8');
}

async function readYaml(relPath: string): Promise<any> {
  return parse(await readText(relPath));
}

test('compose.yml: every published port is bound to 127.0.0.1 only', async () => {
  const compose = await readYaml('compose.yml');
  let sawPort = false;
  for (const service of Object.values<any>(compose.services ?? {})) {
    for (const portEntry of service.ports ?? []) {
      sawPort = true;
      assert.match(
        String(portEntry),
        /^127\.0\.0\.1:/,
        `port entry "${portEntry}" must be bound to 127.0.0.1, not 0.0.0.0 or all interfaces`
      );
    }
  }
  assert.ok(sawPort, 'expected at least one published port in compose.yml to check');
});

test('compose.yml: no service mounts the Docker socket', async () => {
  const content = await readText('compose.yml');
  assert.equal(content.includes('docker.sock'), false, 'compose.yml must not reference docker.sock');

  const compose = await readYaml('compose.yml');
  for (const service of Object.values<any>(compose.services ?? {})) {
    for (const volume of service.volumes ?? []) {
      assert.equal(
        String(volume).includes('docker.sock'),
        false,
        `service volume "${volume}" must not mount the Docker socket`
      );
    }
  }
});

test('dynamic/security.yml: security headers middleware is set', async () => {
  const security = await readYaml('dynamic/security.yml');
  const headers = security.http?.middlewares?.['edgekit-security-headers']?.headers;
  assert.ok(headers, 'edgekit-security-headers middleware must define headers');
  assert.equal(headers.stsSeconds, 31536000, 'HSTS stsSeconds must be set');
  assert.equal(headers.stsIncludeSubdomains, true, 'HSTS must include subdomains');
  assert.equal(headers.customFrameOptionsValue, 'SAMEORIGIN', 'frame options must be SAMEORIGIN');
  assert.equal(headers.contentTypeNosniff, true, 'content type nosniff must be set');
});

test('dynamic/security.yml: rate limit middleware is set', async () => {
  const security = await readYaml('dynamic/security.yml');
  const rateLimit = security.http?.middlewares?.['edgekit-security-ratelimit']?.rateLimit;
  assert.ok(rateLimit, 'edgekit-security-ratelimit middleware must define rateLimit');
  assert.equal(rateLimit.average, 20, 'rate limit average must be 20 req/s');
  assert.equal(rateLimit.burst, 60, 'rate limit burst must be 60');
  assert.equal(
    rateLimit.sourceCriterion?.requestHeaderName,
    'Cf-Connecting-Ip',
    'rate limit must be keyed on Cf-Connecting-Ip'
  );
});

test('dynamic/probe-block.yml: scanner-block router priority is 1000', async () => {
  const probeBlock = await readYaml('dynamic/probe-block.yml');
  const router = probeBlock.http?.routers?.['edgekit-scanner-block'];
  assert.ok(router, 'edgekit-scanner-block router must exist');
  assert.equal(router.priority, 1000, 'probe-block router priority must be 1000');
});

test('dynamic/notfound.yml: catch-all router priority is 1', async () => {
  const notfound = await readYaml('dynamic/notfound.yml');
  const router = notfound.http?.routers?.['edgekit-notfound'];
  assert.ok(router, 'edgekit-notfound router must exist');
  assert.equal(router.priority, 1, 'catch-all router priority must be 1 (lower than probe-block)');
});

test('notfound/default.conf: returns the branded lost-page 404', async () => {
  const content = await readText('notfound/default.conf');
  assert.ok(content.includes('return 404'), 'default.conf must return HTTP 404');
  assert.ok(
    content.includes('{"statusCode":404,"message":"Howdy, you seem lost. Resources not found"}'),
    'default.conf must return the exact branded 404 body'
  );
});

test('src/domain/routeSpec.ts: reserved owners and the public-owner gate', async () => {
  const content = await readText('src/domain/routeSpec.ts');
  const match = content.match(/DEFAULT_RESERVED_OWNERS\s*=\s*\[([^\]]+)\]/);
  assert.ok(match, 'DEFAULT_RESERVED_OWNERS array must be defined');
  const reserved = match![1];
  for (const owner of ['apps', 'admin', 'api', 'control', 'connect']) {
    assert.ok(reserved.includes(`'${owner}'`), `DEFAULT_RESERVED_OWNERS must include '${owner}'`);
  }
  assert.ok(
    content.includes("is not allowed to register public routes"),
    'public access must be gated on policy.publicOwners'
  );
});

test('src/domain/routeSpec.ts: targets must be an IPv4-literal address', async () => {
  const content = await readText('src/domain/routeSpec.ts');
  assert.ok(
    content.includes('must be an http://<IPv4 literal>:<port> URL'),
    'target must be rejected unless it is an http://<IPv4 literal>:<port> URL'
  );
  assert.ok(
    content.includes('target host must be a valid IPv4 literal'),
    'a non-IPv4-literal target host (DNS name, IPv6) must be rejected'
  );
});

test('src/cli/main.ts: CF_API_TOKEN is read from the environment only, never a flag, never on disk', async () => {
  const content = await readText('src/cli/main.ts');
  assert.ok(
    content.includes('process.env.CF_API_TOKEN'),
    'CF_API_TOKEN must be read from process.env'
  );
  assert.equal(
    /flags\[['"]token['"]\]/.test(content),
    false,
    'CF_API_TOKEN must never be accepted as a --token CLI flag'
  );
});

test('scripts/security-audit.sh: fails on a Docker socket reference, loose .env permissions, or a committed token/key', async () => {
  const content = await readText('scripts/security-audit.sh');
  assert.ok(content.includes('docker.sock'), 'security-audit.sh must check for docker.sock references');
  assert.ok(content.includes('.env'), 'security-audit.sh must check .env* file permissions');
  assert.ok(content.includes('PRIVATE KEY'), 'security-audit.sh must check for committed private keys');
  assert.ok(content.includes('TOKEN'), 'security-audit.sh must check for committed token values');
});

test('src/verifier/server.ts: a request with no Cf-Access-Jwt-Assertion header fails closed (401)', async () => {
  const jwks: Jwks = { keys: [] };
  const fetcher: JwksFetcher = async () => jwks;
  const server = createVerifierServer({
    teamDomain: 'hardening-test.cloudflareaccess.com',
    aud: 'hardening-test-aud',
    jwksFetcher: fetcher,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/verify`);
    assert.equal(res.status, 401, 'a request with no Access JWT must be rejected, not allowed through');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('compose.yml: Traefik access log is written as JSON', async () => {
  const compose = await readYaml('compose.yml');
  const command: string[] = compose.services?.traefik?.command ?? [];
  assert.ok(command.includes('--accesslog=true'), 'Traefik access log must be enabled');
  assert.ok(command.includes('--accesslog.format=json'), 'Traefik access log must be JSON formatted');
});

test('scripts/rotate_traefik_logs.sh: rotates, signals, compresses and prunes archives', async () => {
  const stat = await fs.stat(path.resolve(process.cwd(), 'scripts/rotate_traefik_logs.sh'));
  assert.ok(stat.mode & 0o111, 'rotate_traefik_logs.sh must be executable');

  const content = await readText('scripts/rotate_traefik_logs.sh');
  assert.ok(content.includes('ARCHIVE_BASE'), 'rotation must archive the log, not just delete it');
  assert.ok(content.includes('EDGEKIT_ROTATE_DAYS'), 'rotation must be age-based (EDGEKIT_ROTATE_DAYS)');
  assert.ok(content.includes('USR1'), 'rotation must signal Traefik to reopen its log file');
  assert.ok(
    content.includes('xz') || content.includes('gzip'),
    'rotated archives must be compressed'
  );
  assert.ok(content.includes('MAX_ARCHIVES'), 'rotation must prune old archives, not keep them forever');
});
