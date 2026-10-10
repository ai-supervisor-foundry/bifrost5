import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveId, validateRouteSpec, type Policy } from '../../src/domain/routeSpec.ts';

const defaultPolicy: Policy = {
  reservedOwners: ['foundry*', 'apps', 'admin', 'api', 'control', 'connect'],
  allowedHosts: ['sites.example.com', 'api.example.com'],
  ownerCidrs: {
    alice: ['10.20.0.0/16'],
    bob: ['10.30.0.0/16', '192.168.1.0/24'],
  },
  denyIps: ['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8'],
  publicOwners: ['bob'],
};

test('deriveId produces owner--name', () => {
  assert.equal(deriveId('alice', 'blog'), 'alice--blog');
  assert.equal(deriveId('team1', 'service-a'), 'team1--service-a');
});

interface TestCase {
  name: string;
  input: unknown;
  policy?: Policy;
  expectOk: boolean;
  expectedErrorSubstring?: string;
  expectedAccess?: 'private' | 'public';
}

const cases: TestCase[] = [
  {
    name: '1. valid private spec with all fields',
    input: {
      owner: 'alice',
      id: 'alice--blog',
      host: 'sites.example.com',
      pathPrefix: '/p/alice--blog/',
      target: 'http://10.20.0.5:3000',
      access: 'private',
      stripPrefix: true,
    },
    expectOk: true,
    expectedAccess: 'private',
  },
  {
    name: '2. default access is private when omitted',
    input: {
      owner: 'alice',
      id: 'alice--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: true,
    expectedAccess: 'private',
  },
  {
    name: '3. bad owner with hyphen is rejected',
    input: {
      owner: 'alice-bob',
      id: 'alice-bob--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'owner must match',
  },
  {
    name: '4. uppercase characters in owner are rejected',
    input: {
      owner: 'Alice',
      id: 'Alice--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'owner must match',
  },
  {
    name: '5. name too long (> 39 chars) is rejected',
    input: {
      owner: 'alice',
      id: 'alice--' + 'a'.repeat(40),
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'name must match',
  },
  {
    name: '6. name starting with hyphen is rejected',
    input: {
      owner: 'alice',
      id: 'alice---badname',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'name must match',
  },
  {
    name: '7. id mismatch with owner--name is rejected',
    input: {
      owner: 'alice',
      id: 'bob--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'id must equal',
  },
  {
    name: '8. alice vs alice-bob collision prevention (owner alice cannot take alice-bob)',
    input: {
      owner: 'alice',
      id: 'alice--bob--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: true, // alice owns id 'alice--bob--blog' (name 'bob--blog' is valid), owner alice-bob is illegal
  },
  {
    name: '9. reserved owner foundry* prefix match',
    input: {
      owner: 'foundrytest',
      id: 'foundrytest--app',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'matches reserved pattern',
  },
  {
    name: '10. reserved owner exact match (apps)',
    input: {
      owner: 'apps',
      id: 'apps--portal',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'matches reserved pattern',
  },
  {
    name: '11. reserved id matching reserved pattern (foundry--x)',
    input: {
      owner: 'alice',
      id: 'foundry--x',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'matches reserved pattern',
  },
  {
    name: '12. backtick in host is rejected',
    input: {
      owner: 'alice',
      id: 'alice--app',
      host: '`evil`.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'host must match',
  },
  {
    name: '13. host not in allow-list is rejected',
    input: {
      owner: 'alice',
      id: 'alice--app',
      host: 'unknown.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'not in policy.allowedHosts',
  },
  {
    name: '14. DNS-name target is rejected',
    input: {
      owner: 'alice',
      id: 'alice--app',
      host: 'sites.example.com',
      target: 'http://backend.internal:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'target host must be a valid IPv4 literal',
  },
  {
    name: '15. IPv6 target is rejected',
    input: {
      owner: 'alice',
      id: 'alice--app',
      host: 'sites.example.com',
      target: 'http://[::1]:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'target must be an http://<IPv4 literal>:<port> URL',
  },
  {
    name: '16. loopback target (127.0.0.1) is rejected',
    input: {
      owner: 'alice',
      id: 'alice--app',
      host: 'sites.example.com',
      target: 'http://127.0.0.1:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'target IP is in denied range',
  },
  {
    name: '17. link-local target (169.254.169.254) is rejected',
    input: {
      owner: 'alice',
      id: 'alice--app',
      host: 'sites.example.com',
      target: 'http://169.254.169.254:80',
    },
    expectOk: false,
    expectedErrorSubstring: 'target IP is in denied range',
  },
  {
    name: '18. foreign CIDR target IP is rejected',
    input: {
      owner: 'alice',
      id: 'alice--app',
      host: 'sites.example.com',
      target: 'http://10.30.0.5:3000', // bob's CIDR, not alice's
    },
    expectOk: false,
    expectedErrorSubstring: 'target IP is outside allowed CIDRs',
  },
  {
    name: '19. owner without CIDR is rejected',
    input: {
      owner: 'charlie',
      id: 'charlie--app',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'no allowed CIDRs defined for owner',
  },
  {
    name: '20. caller pathPrefix mismatch is rejected',
    input: {
      owner: 'alice',
      id: 'alice--blog',
      host: 'sites.example.com',
      pathPrefix: '/p/wrong-prefix/',
      target: 'http://10.20.0.5:3000',
    },
    expectOk: false,
    expectedErrorSubstring: "pathPrefix must be '/p/alice--blog/'",
  },
  {
    name: '21. public access without permission is rejected',
    input: {
      owner: 'alice',
      id: 'alice--blog',
      host: 'sites.example.com',
      target: 'http://10.20.0.5:3000',
      access: 'public',
    },
    expectOk: false,
    expectedErrorSubstring: 'not allowed to register public routes',
  },
  {
    name: '22. public access with permission is allowed',
    input: {
      owner: 'bob',
      id: 'bob--web',
      host: 'sites.example.com',
      target: 'http://10.30.0.10:8080',
      access: 'public',
    },
    expectOk: true,
    expectedAccess: 'public',
  },
  {
    name: '23. missing fields reports all errors',
    input: {},
    expectOk: false,
    expectedErrorSubstring: 'owner is required',
  },
  {
    name: '24. non-object input is rejected',
    input: 'a string',
    expectOk: false,
    expectedErrorSubstring: 'Input must be a non-null object',
  },
  {
    name: '25. null input is rejected',
    input: null,
    expectOk: false,
    expectedErrorSubstring: 'Input must be a non-null object',
  },
  {
    name: '26. invalid IPv4 format in target (e.g. 256 or octets missing)',
    input: {
      owner: 'alice',
      id: 'alice--app',
      host: 'sites.example.com',
      target: 'http://10.20.0.300:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'target host must be a valid IPv4 literal',
  },
  {
    name: '27. 0.0.0.0/8 target IP is rejected',
    input: {
      owner: 'alice',
      id: 'alice--app',
      host: 'sites.example.com',
      target: 'http://0.0.0.1:3000',
    },
    expectOk: false,
    expectedErrorSubstring: 'target IP is in denied range',
  },
];

for (const tc of cases) {
  test(`validateRouteSpec: ${tc.name}`, () => {
    const policy = tc.policy ?? defaultPolicy;
    const result = validateRouteSpec(tc.input, policy);
    if (tc.expectOk) {
      assert.equal(result.ok, true, `Expected ok but got errors: ${result.ok ? '' : result.errors.join(', ')}`);
      if (result.ok) {
        if (tc.expectedAccess) {
          assert.equal(result.spec.access, tc.expectedAccess);
        }
        assert.equal(result.spec.pathPrefix, `/p/${result.spec.id}/`);
      }
    } else {
      assert.equal(result.ok, false, `Expected failure for test case ${tc.name}`);
      if (!result.ok && tc.expectedErrorSubstring) {
        const hasMatch = result.errors.some(err => err.includes(tc.expectedErrorSubstring!));
        assert.equal(
          hasMatch,
          true,
          `Expected error containing "${tc.expectedErrorSubstring}", got: ${result.errors.join('; ')}`
        );
      }
    }
  });
}
