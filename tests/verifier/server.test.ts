import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createVerifierServer, type Jwks, type JwksFetcher } from '../../src/verifier/server.ts';

const TEAM_DOMAIN = 'test-team.cloudflareaccess.com';
const AUD = 'test-aud-0123456789';
const KID = 'test-key-1';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signToken(
  privateKey: crypto.KeyObject,
  payload: Record<string, unknown>,
  opts: { kid?: string; alg?: string } = {}
): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID, typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function generateKeyPairAndJwks(kid: string): { privateKey: crypto.KeyObject; jwks: Jwks } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return {
    privateKey,
    jwks: { keys: [{ ...jwk, kid } as Jwks['keys'][number]] },
  };
}

async function withServer(
  fetcher: JwksFetcher,
  now: () => number,
  run: (baseUrl: string, fetchCalls: () => number) => Promise<void>
): Promise<void> {
  let fetchCalls = 0;
  const countingFetcher: JwksFetcher = async (teamDomain) => {
    fetchCalls++;
    return fetcher(teamDomain);
  };

  const server = createVerifierServer({ teamDomain: TEAM_DOMAIN, aud: AUD, jwksFetcher: countingFetcher, now });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`, () => fetchCalls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /verify without the Cf-Access-Jwt-Assertion header returns 401', async () => {
  const { jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const now = () => Date.UTC(2026, 0, 1);

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`);
    assert.equal(res.status, 401);
  });
});

test('GET /verify with a validly signed token and matching aud returns 200', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(privateKey, {
    aud: AUD,
    exp: Math.floor(nowMs / 1000) + 3600,
    sub: 'user@example.com',
  });

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    assert.equal(res.status, 200);
  });
});

test('GET /verify with an expired token returns 401', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(privateKey, {
    aud: AUD,
    exp: Math.floor(nowMs / 1000) - 60,
    sub: 'user@example.com',
  });

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    assert.equal(res.status, 401);
  });
});

test('GET /verify with the wrong aud returns 401', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(privateKey, {
    aud: 'some-other-application',
    exp: Math.floor(nowMs / 1000) + 3600,
    sub: 'user@example.com',
  });

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    assert.equal(res.status, 401);
  });
});

test('GET /verify with a token signed by an unrelated key returns 401', async () => {
  const { jwks } = generateKeyPairAndJwks(KID);
  const { privateKey: otherPrivateKey } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(otherPrivateKey, {
    aud: AUD,
    exp: Math.floor(nowMs / 1000) + 3600,
  });

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    assert.equal(res.status, 401);
  });
});

test('GET /verify with a malformed token returns 401', async () => {
  const { jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const now = () => Date.UTC(2026, 0, 1);

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': 'not-a-jwt' },
    });
    assert.equal(res.status, 401);
  });
});

test('JWKS is cached across requests and only refetched once per TTL window', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(privateKey, {
    aud: AUD,
    exp: Math.floor(nowMs / 1000) + 3600,
  });

  await withServer(fetcher, now, async (baseUrl, fetchCalls) => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/verify`, {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      });
      assert.equal(res.status, 200);
    }
    assert.equal(fetchCalls(), 1, 'JWKS fetcher should be called once and then served from cache');
  });
});

test('unknown route returns 404', async () => {
  const { jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const now = () => Date.UTC(2026, 0, 1);

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/other`);
    assert.equal(res.status, 404);
  });
});
