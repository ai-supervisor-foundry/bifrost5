import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';

async function loadCompose() {
  const composePath = path.resolve(process.cwd(), 'compose.yml');
  const content = await fs.readFile(composePath, 'utf8');
  return parse(content);
}

async function loadSecurity() {
  const securityPath = path.resolve(process.cwd(), 'dynamic/security.yml');
  const content = await fs.readFile(securityPath, 'utf8');
  return parse(content);
}

test('access-verifier service exists and shares the traefik network', async () => {
  const compose = await loadCompose();

  const traefik = compose.services?.traefik;
  assert.ok(traefik, 'traefik service must be defined');
  assert.ok(Array.isArray(traefik.networks), 'traefik.networks must be an array');

  const accessVerifier = compose.services?.['access-verifier'];
  assert.ok(accessVerifier, 'access-verifier service must be defined');
  assert.ok(Array.isArray(accessVerifier.networks), 'access-verifier.networks must be an array');

  const sharedNetwork = traefik.networks.find((net: string) =>
    accessVerifier.networks.includes(net)
  );
  assert.ok(
    sharedNetwork,
    'access-verifier must be on the same network as traefik'
  );
});

test('access-verifier publishes no host ports', async () => {
  const compose = await loadCompose();

  const accessVerifier = compose.services?.['access-verifier'];
  assert.ok(accessVerifier, 'access-verifier service must be defined');
  assert.ok(
    accessVerifier.ports === undefined || accessVerifier.ports.length === 0,
    'access-verifier must not publish any host ports'
  );
});

test('edgekit-access-jwt middleware uses forwardAuth pointed at access-verifier', async () => {
  const security = await loadSecurity();

  const middleware = security.http?.middlewares?.['edgekit-access-jwt'];
  assert.ok(middleware, 'edgekit-access-jwt middleware must be defined');

  const forwardAuth = middleware.forwardAuth;
  assert.ok(forwardAuth, 'edgekit-access-jwt must configure forwardAuth');
  assert.equal(
    forwardAuth.address,
    'http://access-verifier:9000/verify',
    'forwardAuth.address must point at the access-verifier service'
  );
});

test('forwardAuth forwards the Cf-Access-Jwt-Assertion header', async () => {
  const security = await loadSecurity();

  const forwardAuth = security.http?.middlewares?.['edgekit-access-jwt']?.forwardAuth;
  assert.ok(forwardAuth, 'edgekit-access-jwt must configure forwardAuth');
  assert.ok(
    Array.isArray(forwardAuth.authRequestHeaders),
    'forwardAuth.authRequestHeaders must be an array'
  );
  assert.ok(
    forwardAuth.authRequestHeaders.includes('Cf-Access-Jwt-Assertion'),
    'forwardAuth.authRequestHeaders must include Cf-Access-Jwt-Assertion'
  );
});

test('access-verifier reads CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD from the environment', async () => {
  const compose = await loadCompose();

  const accessVerifier = compose.services?.['access-verifier'];
  assert.ok(accessVerifier, 'access-verifier service must be defined');
  assert.ok(
    accessVerifier.environment && typeof accessVerifier.environment === 'object',
    'access-verifier.environment must be defined'
  );
  assert.ok(
    'CF_ACCESS_TEAM_DOMAIN' in accessVerifier.environment,
    'access-verifier.environment must include CF_ACCESS_TEAM_DOMAIN'
  );
  assert.ok(
    'CF_ACCESS_AUD' in accessVerifier.environment,
    'access-verifier.environment must include CF_ACCESS_AUD'
  );
});
