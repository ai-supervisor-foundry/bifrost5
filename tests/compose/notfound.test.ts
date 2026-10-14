import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';

const EXPECTED_BODY = '{"statusCode":404,"message":"Howdy, you seem lost. Resources not found"}';

async function loadCompose() {
  const composePath = path.resolve(process.cwd(), 'compose.yml');
  const content = await fs.readFile(composePath, 'utf8');
  return parse(content);
}

async function loadNotfoundRouter() {
  const notfoundPath = path.resolve(process.cwd(), 'dynamic/notfound.yml');
  const content = await fs.readFile(notfoundPath, 'utf8');
  return parse(content);
}

test('edgekit-notfound service publishes no host ports', async () => {
  const compose = await loadCompose();

  const service = compose.services?.['edgekit-notfound'];
  assert.ok(service, 'edgekit-notfound service must be defined in compose.yml');
  assert.ok(
    service.ports === undefined || service.ports.length === 0,
    'edgekit-notfound must not publish any host ports'
  );
});

test('edgekit-notfound service mounts notfound/default.conf read-only', async () => {
  const compose = await loadCompose();

  const service = compose.services?.['edgekit-notfound'];
  assert.ok(service, 'edgekit-notfound service must be defined in compose.yml');
  assert.ok(Array.isArray(service.volumes), 'edgekit-notfound.volumes must be an array');
  assert.ok(
    service.volumes.includes('./notfound/default.conf:/etc/nginx/conf.d/default.conf:ro'),
    'edgekit-notfound must mount ./notfound/default.conf read-only'
  );
});

test('edgekit-notfound service is on edgekit-net', async () => {
  const compose = await loadCompose();

  const service = compose.services?.['edgekit-notfound'];
  assert.ok(service, 'edgekit-notfound service must be defined in compose.yml');
  assert.ok(Array.isArray(service.networks), 'edgekit-notfound.networks must be an array');
  assert.ok(
    service.networks.includes('edgekit-net'),
    'edgekit-notfound must be on edgekit-net'
  );
});

test('dynamic/notfound.yml router has priority 1 and does not outrank probe-block', async () => {
  const notfound = await loadNotfoundRouter();

  const router = notfound.http?.routers?.['edgekit-notfound'];
  assert.ok(router, 'edgekit-notfound router must be defined');
  assert.equal(router.priority, 1, 'edgekit-notfound router priority must be 1');
  assert.ok(
    router.priority < 1000,
    'edgekit-notfound router must not outrank the priority-1000 probe-block router'
  );
});

test('dynamic/notfound.yml router matches PathPrefix(`/`) and uses edgekit-security@file first', async () => {
  const notfound = await loadNotfoundRouter();

  const router = notfound.http?.routers?.['edgekit-notfound'];
  assert.ok(router, 'edgekit-notfound router must be defined');
  assert.equal(router.rule, 'PathPrefix(`/`)', 'edgekit-notfound router rule must be PathPrefix(`/`)');
  assert.ok(Array.isArray(router.middlewares), 'edgekit-notfound.middlewares must be an array');
  assert.equal(
    router.middlewares[0],
    'edgekit-security@file',
    'edgekit-security@file must be the first middleware'
  );
});

test('dynamic/notfound.yml router service points at http://edgekit-notfound:80', async () => {
  const notfound = await loadNotfoundRouter();

  const router = notfound.http?.routers?.['edgekit-notfound'];
  assert.ok(router, 'edgekit-notfound router must be defined');
  assert.equal(router.service, 'edgekit-notfound', 'router service must be edgekit-notfound');

  const service = notfound.http?.services?.['edgekit-notfound'];
  assert.ok(service, 'edgekit-notfound service must be defined');
  const url = service.loadBalancer?.servers?.[0]?.url;
  assert.equal(url, 'http://edgekit-notfound:80', 'service must point at http://edgekit-notfound:80');
});

test('notfound/default.conf returns the branded 404 JSON body', async () => {
  const confPath = path.resolve(process.cwd(), 'notfound/default.conf');
  const content = await fs.readFile(confPath, 'utf8');

  assert.ok(content.includes('listen 80;'), 'default.conf must listen on port 80');
  assert.ok(
    content.includes('default_type application/json;'),
    'default.conf must default to application/json'
  );
  assert.ok(content.includes('return 404'), 'default.conf must return a 404 status');
  assert.ok(
    content.includes(EXPECTED_BODY),
    'default.conf must return the exact branded 404 message'
  );
});
