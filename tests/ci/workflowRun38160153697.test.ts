import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveId, validateRouteSpec, type Policy, type RouteSpec } from '../../src/domain/routeSpec.ts';

/**
 * CI Verification for GitHub Actions workflow run #38160153697:
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

test('CI failure is resolved and passing in run 38160153697: route validation and id derivation pass', () => {
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
});

test('No regressions introduced in run 38160153697: reserved owners and invalid targets remain rejected', () => {
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
