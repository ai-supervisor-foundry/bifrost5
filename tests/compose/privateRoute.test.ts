import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createVerifierServer, type Jwks, type JwksFetcher } from '../../src/verifier/server.ts';

// Traefik forwards every private-route request here: dynamic/security.yml's
// edgekit-access-jwt@file middleware (forwardAuth.address =
// http://access-verifier:9000/verify) relays the Cf-Access-Jwt-Assertion
// header to this /verify endpoint and gates the route on its response code.

const TEAM_DOMAIN = 'proof-team.cloudflareaccess.com';
const AUD = 'proof-aud-abcdef0123456789';
const KID = 'proof-key-1';

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

function assertRejected(status: number): void {
  assert.ok(status === 401 || status === 403, `expected 401 or 403, got ${status}`);
}

async function withServer(
  fetcher: JwksFetcher,
  now: () => number,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createVerifierServer({ teamDomain: TEAM_DOMAIN, aud: AUD, jwksFetcher: fetcher, now });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('private route: request with no Cf-Access-Jwt-Assertion header is rejected', async () => {
  const { jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const now = () => Date.UTC(2026, 0, 1);

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`);
    assertRejected(res.status);
  });
});

test('private route: token signed by a different key is rejected', async () => {
  const { jwks } = generateKeyPairAndJwks(KID);
  const { privateKey: wrongKey } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(wrongKey, {
    iss: `https://${TEAM_DOMAIN}`,
    aud: AUD,
    exp: Math.floor(nowMs / 1000) + 3600,
    sub: 'proof@example.com',
  });

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    assertRejected(res.status);
  });
});

test('private route: expired token is rejected', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(privateKey, {
    iss: `https://${TEAM_DOMAIN}`,
    aud: AUD,
    exp: Math.floor(nowMs / 1000) - 60,
    sub: 'proof@example.com',
  });

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    assertRejected(res.status);
  });
});

test('private route: valid token with right aud and issuer returns 200', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(privateKey, {
    iss: `https://${TEAM_DOMAIN}`,
    aud: AUD,
    exp: Math.floor(nowMs / 1000) + 3600,
    sub: 'proof@example.com',
  });

  await withServer(fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    assert.equal(res.status, 200);
  });
});
