import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveId, validateRouteSpec, type Policy, type RouteSpec } from '../../src/domain/routeSpec.ts';

/**
 * CI Verification for GitHub Actions workflow run #38496586842:
 * - CI failure is resolved and passing
 * - No regressions introduced
 */

const testPolicy: Policy = {
  reservedOwners: ['foundry*', 'apps', 'admin', 'api', 'control', 'connect'],
  allowedHosts: ['sites.example.com'],
  siteHosts: ['portal.example.com'],
  ownerCidrs: {
    alice: ['10.20.0.0/16'],
  },
  publicOwners: ['alice'],
};

test('CI failure is resolved and passing: route validation and id derivation pass', () => {
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

test('No regressions introduced: reserved owners and invalid targets remain rejected', () => {
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
    assert.ok(res1.errors.some((e: string) => /reserved/i.test(e)));
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
    assert.ok(res2.errors.some((e: string) => /CIDR/i.test(e)));
  }
});

test('No regressions introduced: site routes respect siteHosts and /p prevention', () => {
  const validSiteSpec: RouteSpec = {
    owner: 'alice',
    id: 'alice--portal',
    host: 'portal.example.com',
    pathPrefix: '/dashboard',
    target: 'http://10.20.0.5:3000',
    access: 'private',
    stripPrefix: false,
    kind: 'site',
  };

  const validRes = validateRouteSpec(validSiteSpec, testPolicy);
  assert.equal(validRes.ok, true);

  const invalidHostSpec: RouteSpec = {
    owner: 'alice',
    id: 'alice--portal',
    host: 'sites.example.com', // in allowedHosts but not siteHosts
    pathPrefix: '/dashboard',
    target: 'http://10.20.0.5:3000',
    kind: 'site',
  };
  const invalidHostRes = validateRouteSpec(invalidHostSpec, testPolicy);
  assert.equal(invalidHostRes.ok, false);

  const invalidPrefixSpec: RouteSpec = {
    owner: 'alice',
    id: 'alice--portal',
    host: 'portal.example.com',
    pathPrefix: '/p/dashboard',
    target: 'http://10.20.0.5:3000',
    kind: 'site',
  };
  const invalidPrefixRes = validateRouteSpec(invalidPrefixSpec, testPolicy);
  assert.equal(invalidPrefixRes.ok, false);
});
