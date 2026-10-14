import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createVerifierServer, type Jwks, type JwksFetcher } from '../../src/verifier/server.ts';

const TEAM_DOMAIN = 'test-team.cloudflareaccess.com';
const AUD_1 = 'test-aud-primary-0123';
const AUD_2 = 'test-aud-secondary-4567';
const KID = 'test-key-multi';

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

async function withMultiAudServer(
  aud: string | string[],
  fetcher: JwksFetcher,
  now: () => number,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createVerifierServer({ teamDomain: TEAM_DOMAIN, aud, jwksFetcher: fetcher, now });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('two audiences, token for the second passes', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(privateKey, {
    aud: AUD_2,
    exp: Math.floor(nowMs / 1000) + 3600,
    sub: 'user@example.com',
  });

  await withMultiAudServer(`${AUD_1}, ${AUD_2}`, fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    assert.equal(res.status, 200);
  });
});

test('token for neither fails', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token = signToken(privateKey, {
    aud: 'neither-audience',
    exp: Math.floor(nowMs / 1000) + 3600,
    sub: 'user@example.com',
  });

  await withMultiAudServer(`${AUD_1}, ${AUD_2}`, fetcher, now, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    assert.equal(res.status, 401);
  });
});

test('array aud claim', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const tokenValid = signToken(privateKey, {
    aud: ['unrelated-aud', AUD_2],
    exp: Math.floor(nowMs / 1000) + 3600,
    sub: 'user@example.com',
  });

  const tokenInvalid = signToken(privateKey, {
    aud: ['unrelated-aud-1', 'unrelated-aud-2'],
    exp: Math.floor(nowMs / 1000) + 3600,
    sub: 'user@example.com',
  });

  await withMultiAudServer(`${AUD_1}, ${AUD_2}`, fetcher, now, async (baseUrl) => {
    const resValid = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': tokenValid },
    });
    assert.equal(resValid.status, 200);

    const resInvalid = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': tokenInvalid },
    });
    assert.equal(resInvalid.status, 401);
  });
});

test('empty entry ignored', async () => {
  const { privateKey, jwks } = generateKeyPairAndJwks(KID);
  const fetcher: JwksFetcher = async () => jwks;
  const nowMs = Date.UTC(2026, 0, 1);
  const now = () => nowMs;

  const token1 = signToken(privateKey, {
    aud: AUD_1,
    exp: Math.floor(nowMs / 1000) + 3600,
  });
  const token2 = signToken(privateKey, {
    aud: AUD_2,
    exp: Math.floor(nowMs / 1000) + 3600,
  });
  const tokenEmpty = signToken(privateKey, {
    aud: '',
    exp: Math.floor(nowMs / 1000) + 3600,
  });

  // Leading, trailing, and intermediate spaces and empty commas
  await withMultiAudServer(`  ${AUD_1}  ,  ,  ${AUD_2}  ,  `, fetcher, now, async (baseUrl) => {
    const res1 = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': token1 },
    });
    assert.equal(res1.status, 200);

    const res2 = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': token2 },
    });
    assert.equal(res2.status, 200);

    const resEmpty = await fetch(`${baseUrl}/verify`, {
      headers: { 'Cf-Access-Jwt-Assertion': tokenEmpty },
    });
    assert.equal(resEmpty.status, 401);
  });
});

test('startup fails with no audience', async () => {
  // Server creation throws when aud is empty, whitespace, or empty array
  assert.throws(() => {
    createVerifierServer({ teamDomain: TEAM_DOMAIN, aud: '' });
  });
  assert.throws(() => {
    createVerifierServer({ teamDomain: TEAM_DOMAIN, aud: '   ,   ' });
  });
  assert.throws(() => {
    createVerifierServer({ teamDomain: TEAM_DOMAIN, aud: [] });
  });

  // CLI startup exits with code 1 when CF_ACCESS_AUD is empty or unset
  const exitCodeEmpty = await new Promise<number | null>((resolve) => {
    const proc = spawn('node', ['src/verifier/server.ts'], {
      env: { ...process.env, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: '   ,   ' },
      stdio: 'pipe',
    });
    proc.on('close', (code) => resolve(code));
  });
  assert.equal(exitCodeEmpty, 1);

  const exitCodeUnset = await new Promise<number | null>((resolve) => {
    const env = { ...process.env, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN };
    delete env.CF_ACCESS_AUD;
    const proc = spawn('node', ['src/verifier/server.ts'], {
      env,
      stdio: 'pipe',
    });
    proc.on('close', (code) => resolve(code));
  });
  assert.equal(exitCodeUnset, 1);
});
