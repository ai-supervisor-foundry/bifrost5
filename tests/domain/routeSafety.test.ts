import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidId, validateRouteSpec, type Policy } from '../../src/domain/routeSpec.ts';

const basePolicy: Policy = {
  allowedHosts: ['sites.example.com'],
  ownerCidrs: {
    alice: ['10.20.0.0/16'],
    x: ['10.20.0.0/16'],
    foundry: ['10.20.0.0/16'],
    apps: ['10.20.0.0/16'],
  },
};

test('name a--b rejected in route validation', () => {
  const result = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--a--b',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    basePolicy
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    const hasNameError = result.errors.some(err => err.includes('name must match'));
    assert.equal(hasNameError, true, `Expected name error, got: ${result.errors.join('; ')}`);
  }
});

test('policy with reservedOwners: [x] still rejects foundry and apps owners', () => {
  const policyWithCustomReserved: Policy = {
    ...basePolicy,
    reservedOwners: ['x'],
  };

  // Check 'foundry'
  const resultFoundry = validateRouteSpec(
    {
      owner: 'foundry',
      id: 'foundry--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    policyWithCustomReserved
  );
  assert.equal(resultFoundry.ok, false);
  if (!resultFoundry.ok) {
    const hasReserved = resultFoundry.errors.some(err => err.includes('reserved pattern'));
    assert.equal(hasReserved, true, `Expected reserved pattern error, got: ${resultFoundry.errors.join('; ')}`);
  }

  // Check 'apps'
  const resultApps = validateRouteSpec(
    {
      owner: 'apps',
      id: 'apps--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    policyWithCustomReserved
  );
  assert.equal(resultApps.ok, false);
  if (!resultApps.ok) {
    const hasReserved = resultApps.errors.some(err => err.includes('reserved pattern'));
    assert.equal(hasReserved, true, `Expected reserved pattern error, got: ${resultApps.errors.join('; ')}`);
  }

  // Check 'x'
  const resultX = validateRouteSpec(
    {
      owner: 'x',
      id: 'x--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    policyWithCustomReserved
  );
  assert.equal(resultX.ok, false);
  if (!resultX.ok) {
    const hasReserved = resultX.errors.some(err => err.includes('reserved pattern'));
    assert.equal(hasReserved, true, `Expected reserved pattern error, got: ${resultX.errors.join('; ')}`);
  }
});

test('isValidId returns true for valid id and false for invalid ids', () => {
  // true for 'alice--blog'
  assert.equal(isValidId('alice--blog'), true);

  // false for each bad example specified in task description
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('security'), false);
  assert.equal(isValidId('../../x'), false);
  assert.equal(isValidId('a/b'), false);
  assert.equal(isValidId('a.b'), false);

  // uppercase
  assert.equal(isValidId('Alice--blog'), false);
  assert.equal(isValidId('alice--Blog'), false);
  assert.equal(isValidId('ALICE--BLOG'), false);

  // anything with a path separator or dot
  assert.equal(isValidId('alice/bob--blog'), false);
  assert.equal(isValidId('alice--blog/post'), false);
  assert.equal(isValidId('alice.bob--blog'), false);
  assert.equal(isValidId('alice--blog.html'), false);

  // name with double hyphen 'a--b' rejected
  assert.equal(isValidId('alice--a--b'), false);
});
