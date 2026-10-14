import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRouteSpec, type Policy, type RouteSpec } from '../../src/domain/routeSpec.ts';

const basePolicy: Policy = {
  allowedHosts: ['sites.example.com'],
  siteHosts: ['portal.example.com', 'admin.example.com'],
  ownerCidrs: {
    alice: ['10.20.0.0/16'],
    bob: ['10.30.0.0/16'],
  },
  publicOwners: ['bob'],
};

test('valid site route passes validation', () => {
  const result = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--control',
      host: 'portal.example.com',
      pathPrefix: '/control',
      target: 'http://10.20.0.5:3000',
      kind: 'site',
    },
    basePolicy
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.spec.kind, 'site');
    assert.equal(result.spec.pathPrefix, '/control');
    assert.equal(result.spec.stripPrefix, false, 'stripPrefix defaults to false for site routes');
    assert.equal(result.spec.access, 'private');
  }
});

test('host not in siteHosts refused for site route', () => {
  const result = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--control',
      host: 'other.example.com',
      pathPrefix: '/control',
      target: 'http://10.20.0.5:3000',
      kind: 'site',
    },
    basePolicy
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((err) => err.includes('not in policy.siteHosts')),
      `Expected siteHosts error, got: ${result.errors.join('; ')}`
    );
  }
});

test('host in allowedHosts but NOT in siteHosts is refused for site route', () => {
  const result = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--control',
      host: 'sites.example.com', // in allowedHosts, but NOT in siteHosts
      pathPrefix: '/control',
      target: 'http://10.20.0.5:3000',
      kind: 'site',
    },
    basePolicy
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((err) => err.includes('not in policy.siteHosts')),
      `Expected siteHosts error, got: ${result.errors.join('; ')}`
    );
  }
});

test('policy with siteHosts omitted refuses site routes', () => {
  const policyWithoutSiteHosts: Policy = {
    allowedHosts: ['sites.example.com'],
    ownerCidrs: { alice: ['10.20.0.0/16'] },
  };

  const result = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--control',
      host: 'portal.example.com',
      pathPrefix: '/control',
      target: 'http://10.20.0.5:3000',
      kind: 'site',
    },
    policyWithoutSiteHosts
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((err) => err.includes('not in policy.siteHosts')),
      `Expected siteHosts error, got: ${result.errors.join('; ')}`
    );
  }
});

test('/p prefix refused for site route (/p, /p/, /p/anything)', () => {
  const prefixes = ['/p', '/p/', '/p/alice--app', '/p/foo'];

  for (const prefix of prefixes) {
    const result = validateRouteSpec(
      {
        owner: 'alice',
        id: 'alice--app',
        host: 'portal.example.com',
        pathPrefix: prefix,
        target: 'http://10.20.0.5:3000',
        kind: 'site',
      },
      basePolicy
    );

    assert.equal(result.ok, false, `Expected prefix '${prefix}' to be refused`);
    if (!result.ok) {
      assert.ok(
        result.errors.some((err) => err.includes("'/p' and anything under it is refused")),
        `Expected /p prefix error for '${prefix}', got: ${result.errors.join('; ')}`
      );
    }
  }
});

test('path-prefix must start with / and match ^/[a-zA-Z0-9._~/-]*$', () => {
  const badPrefixes = [
    'control', // no leading slash
    '/control with spaces',
    '/control$bad',
    '/control#hash',
    '/control?query',
  ];

  for (const prefix of badPrefixes) {
    const result = validateRouteSpec(
      {
        owner: 'alice',
        id: 'alice--app',
        host: 'portal.example.com',
        pathPrefix: prefix,
        target: 'http://10.20.0.5:3000',
        kind: 'site',
      },
      basePolicy
    );

    assert.equal(result.ok, false, `Expected '${prefix}' to be invalid`);
    if (!result.ok) {
      assert.ok(
        result.errors.some((err) => err.includes('pathPrefix must start with / and match')),
        `Expected regex match error for '${prefix}', got: ${result.errors.join('; ')}`
      );
    }
  }

  // Valid prefixes
  const goodPrefixes = ['/', '/api', '/api/', '/v1.0/~user/_test-route'];
  for (const prefix of goodPrefixes) {
    const result = validateRouteSpec(
      {
        owner: 'alice',
        id: 'alice--app',
        host: 'portal.example.com',
        pathPrefix: prefix,
        target: 'http://10.20.0.5:3000',
        kind: 'site',
      },
      basePolicy
    );

    assert.equal(result.ok, true, `Expected '${prefix}' to be valid, got: ${result.ok ? '' : result.errors.join('; ')}`);
  }
});

test('collision refused: two site routes on same host and prefix', () => {
  const existing: RouteSpec[] = [
    {
      id: 'alice--app1',
      owner: 'alice',
      host: 'portal.example.com',
      pathPrefix: '/api',
      target: 'http://10.20.0.5:3000',
      access: 'private',
      stripPrefix: false,
      kind: 'site',
    },
  ];

  // Different id, same host and prefix -> collision
  const collisionResult = validateRouteSpec(
    {
      owner: 'bob',
      id: 'bob--app2',
      host: 'portal.example.com',
      pathPrefix: '/api',
      target: 'http://10.30.0.5:3000',
      kind: 'site',
    },
    basePolicy,
    existing
  );

  assert.equal(collisionResult.ok, false);
  if (!collisionResult.ok) {
    assert.ok(
      collisionResult.errors.some((err) => err.includes('route collision')),
      `Expected collision error, got: ${collisionResult.errors.join('; ')}`
    );
  }

  // Same host and prefix with trailing slash collision (/api vs /api/)
  const slashCollision = validateRouteSpec(
    {
      owner: 'bob',
      id: 'bob--app2',
      host: 'portal.example.com',
      pathPrefix: '/api/',
      target: 'http://10.30.0.5:3000',
      kind: 'site',
    },
    basePolicy,
    existing
  );
  assert.equal(slashCollision.ok, false);

  // Same id (updating route) -> allowed
  const updateResult = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--app1',
      host: 'portal.example.com',
      pathPrefix: '/api',
      target: 'http://10.20.0.6:3000',
      kind: 'site',
    },
    basePolicy,
    existing
  );
  assert.equal(updateResult.ok, true);

  // Different host -> allowed
  const diffHostResult = validateRouteSpec(
    {
      owner: 'bob',
      id: 'bob--app2',
      host: 'admin.example.com',
      pathPrefix: '/api',
      target: 'http://10.30.0.5:3000',
      kind: 'site',
    },
    basePolicy,
    existing
  );
  assert.equal(diffHostResult.ok, true);
});

test('redirect options: redirectExactFrom requires redirectTo and must use relative Location', () => {
  // Missing redirectTo
  const missingTo = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--app',
      host: 'portal.example.com',
      pathPrefix: '/app',
      target: 'http://10.20.0.5:3000',
      kind: 'site',
      redirectExactFrom: '/',
    },
    basePolicy
  );
  assert.equal(missingTo.ok, false);
  if (!missingTo.ok) {
    assert.ok(missingTo.errors.some((err) => err.includes('requires redirectTo')));
  }

  // Non-relative redirectTo with scheme
  const schemeTo = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--app',
      host: 'portal.example.com',
      pathPrefix: '/app',
      target: 'http://10.20.0.5:3000',
      kind: 'site',
      redirectExactFrom: '/',
      redirectTo: 'https://evil.com/app/',
    },
    basePolicy
  );
  assert.equal(schemeTo.ok, false);
  if (!schemeTo.ok) {
    assert.ok(schemeTo.errors.some((err) => err.includes('relative path starting with /')));
  }

  // Valid relative redirect
  const validRedirect = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--app',
      host: 'portal.example.com',
      pathPrefix: '/app',
      target: 'http://10.20.0.5:3000',
      kind: 'site',
      redirectExactFrom: '/',
      redirectTo: '/app/',
    },
    basePolicy
  );
  assert.equal(validRedirect.ok, true);
  if (validRedirect.ok) {
    assert.equal(validRedirect.spec.redirectExactFrom, '/');
    assert.equal(validRedirect.spec.redirectTo, '/app/');
  }

  // Redirect options on /p route rejected
  const pRouteWithRedirect = validateRouteSpec(
    {
      owner: 'alice',
      id: 'alice--app',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
      redirectExactFrom: '/',
      redirectTo: '/app/',
    },
    basePolicy
  );
  assert.equal(pRouteWithRedirect.ok, false);
  if (!pRouteWithRedirect.ok) {
    assert.ok(pRouteWithRedirect.errors.some((err) => err.includes('only supported for site routes')));
  }
});
