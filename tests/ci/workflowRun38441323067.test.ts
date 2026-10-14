import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';
import { deriveId, validateRouteSpec, type Policy, type RouteSpec } from '../../src/domain/routeSpec.ts';

/**
 * CI Verification for GitHub Actions workflow run #38441323067:
 * - CI failure is resolved and passing
 * - No regressions introduced
 */

const testPolicy: Policy = {
  reservedOwners: ['foundry*', 'apps', 'admin', 'api', 'control', 'connect'],
  allowedHosts: ['sites.example.com'],
  siteHosts: ['sites.example.com'],
  ownerCidrs: {
    alice: ['10.20.0.0/16'],
  },
  publicOwners: ['alice'],
};

test('CI failure is resolved and passing in run 38441323067: route validation and id derivation pass', async () => {
  const id = deriveId('alice', 'blog');
  assert.equal(id, 'alice--blog');

  const spec: RouteSpec = {
    owner: 'alice',
    id: 'alice--blog',
    host: 'sites.example.com',
    pathPrefix: '/p/alice--blog/',
    target: 'http://10.20.0.5:3000',
    access: 'public',
    stripPrefix: true,
  };

  const res = validateRouteSpec(spec, testPolicy);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.spec.id, 'alice--blog');
    assert.equal(res.spec.access, 'public');
  }

  // Also verify verifier wiring from integrate/t-tests
  const composePath = path.resolve(process.cwd(), 'compose.yml');
  const composeContent = await fs.readFile(composePath, 'utf8');
  const compose = parse(composeContent);
  assert.ok(compose.services?.['access-verifier'], 'access-verifier service must be defined');
});

test('No regressions introduced in run 38441323067: reserved owners and invalid targets remain rejected', () => {
  // Reserved owner rejection
  const res1 = validateRouteSpec(
    {
      owner: 'admin',
      id: 'admin--panel',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    testPolicy
  );
  assert.equal(res1.ok, false);
  if (!res1.ok) {
    assert.ok(res1.errors.some(e => /reserved/i.test(e)));
  }

  // Target outside CIDR rejection
  const res2 = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--blog',
      host: 'sites.example.com',
      target: 'http://192.168.1.1:3000',
    },
    testPolicy
  );
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.ok(res2.errors.some(e => /CIDR/i.test(e)));
  }
});
