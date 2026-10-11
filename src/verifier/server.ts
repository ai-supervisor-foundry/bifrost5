import * as http from 'node:http';
import * as crypto from 'node:crypto';
import process from 'node:process';

export interface JwksKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
  [key: string]: unknown;
}

export interface Jwks {
  keys: JwksKey[];
}

export type JwksFetcher = (teamDomain: string) => Promise<Jwks>;

export async function defaultJwksFetcher(teamDomain: string): Promise<Jwks> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS: HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as Jwks;
  if (!body || !Array.isArray(body.keys)) {
    throw new Error('Invalid JWKS response: missing keys array');
  }
  return body;
}

const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Caches JWKS keys by kid. Refetches once on a TTL expiry or on an unknown
 * kid, so key rotation on the Cloudflare side does not require a restart.
 */
export class JwksCache {
  private readonly fetcher: JwksFetcher;
  private readonly teamDomain: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private keysById: Map<string, JwksKey> = new Map();
  private fetchedAtMs = -Infinity;
  private pending: Promise<void> | null = null;

  constructor(params: { fetcher: JwksFetcher; teamDomain: string; ttlMs?: number; now?: () => number }) {
    this.fetcher = params.fetcher;
    this.teamDomain = params.teamDomain;
    this.ttlMs = params.ttlMs ?? DEFAULT_JWKS_TTL_MS;
    this.now = params.now ?? Date.now;
  }

  private isFresh(): boolean {
    return this.now() - this.fetchedAtMs < this.ttlMs;
  }

  private async refresh(): Promise<void> {
    if (!this.pending) {
      this.pending = this.doRefresh();
    }
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async doRefresh(): Promise<void> {
    const jwks = await this.fetcher(this.teamDomain);
    const nextKeys = new Map<string, JwksKey>();
    for (const key of jwks.keys) {
      if (key && typeof key.kid === 'string') {
        nextKeys.set(key.kid, key);
      }
    }
    this.keysById = nextKeys;
    this.fetchedAtMs = this.now();
  }

  async getKey(kid: string): Promise<JwksKey | undefined> {
    if (!this.isFresh()) {
      await this.refresh();
    }
    let key = this.keysById.get(kid);
    if (!key) {
      await this.refresh();
      key = this.keysById.get(kid);
    }
    return key;
  }
}

interface ParsedJwt {
  header: { alg?: string; kid?: string };
  payload: { aud?: string | string[]; exp?: number; [key: string]: unknown };
  signingInput: string;
  signature: Buffer;
}

function parseJwt(token: string): ParsedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const signature = Buffer.from(signatureB64, 'base64url');
    return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature };
  } catch {
    return null;
  }
}

export interface VerifyOptions {
  aud: string;
  jwks: JwksCache;
  now?: () => number;
}

export async function verifyAccessJwt(token: string, opts: VerifyOptions): Promise<boolean> {
  const parsed = parseJwt(token);
  if (!parsed) {
    return false;
  }
  const { header, payload, signingInput, signature } = parsed;

  if (header.alg !== 'RS256' || !header.kid) {
    return false;
  }

  const jwk = await opts.jwks.getKey(header.kid);
  if (!jwk) {
    return false;
  }

  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' });
  } catch {
    return false;
  }

  let signatureValid: boolean;
  try {
    signatureValid = crypto.verify('RSA-SHA256', Buffer.from(signingInput), publicKey, signature);
  } catch {
    return false;
  }
  if (!signatureValid) {
    return false;
  }

  const nowSeconds = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    return false;
  }

  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(opts.aud)) {
    return false;
  }

  return true;
}

export interface CreateVerifierServerOptions {
  teamDomain: string;
  aud: string;
  jwksFetcher?: JwksFetcher;
  jwksTtlMs?: number;
  now?: () => number;
}

export function createVerifierServer(opts: CreateVerifierServerOptions): http.Server {
  const jwks = new JwksCache({
    fetcher: opts.jwksFetcher ?? defaultJwksFetcher,
    teamDomain: opts.teamDomain,
    ttlMs: opts.jwksTtlMs,
    now: opts.now,
  });

  return http.createServer((req, res) => {
    handleRequest(req, res, { aud: opts.aud, jwks, now: opts.now }).catch(() => {
      if (!res.headersSent) {
        res.writeHead(401);
      }
      res.end();
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { aud: string; jwks: JwksCache; now?: () => number }
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET' || url.pathname !== '/verify') {
    res.writeHead(404);
    res.end();
    return;
  }

  const token = req.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string' || token.length === 0) {
    res.writeHead(401);
    res.end();
    return;
  }

  const valid = await verifyAccessJwt(token, { aud: opts.aud, jwks: opts.jwks, now: opts.now });
  res.writeHead(valid ? 200 : 401);
  res.end();
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const aud = process.env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) {
    process.stderr.write('CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must both be set\n');
    process.exit(1);
  }

  const server = createVerifierServer({ teamDomain, aud });
  server.listen(9000, () => {
    process.stdout.write('access-verifier listening on :9000\n');
  });
}
