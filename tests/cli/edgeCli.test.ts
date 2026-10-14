import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const EDGECTL_BIN = path.join(REPO_ROOT, 'bin', 'edgectl');

function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runEdgectl(
  args: string[],
  env: Record<string, string | undefined>
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(EDGECTL_BIN, args, {
      env: {
        ...process.env,
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const SENTINEL_TOKEN = 'cf-api-token-should-never-appear-in-output-abc123';

test('edge ingress without CF_API_TOKEN exits 1 with a clear error and prints no token', async () => {
  const tmpDir = await createTempDir('edgectl-edge-notoken-ingress-');
  try {
    const res = await runEdgectl(
      ['edge', 'ingress', 'app.example.com', '--service', 'http://10.0.0.5:8080'],
      {
        EDGEKIT_STATE_DIR: tmpDir,
        EDGEKIT_DYNAMIC_DIR: undefined,
        EDGEKIT_POLICY: undefined,
        EDGEKIT_ENABLED: undefined,
        CF_API_TOKEN: undefined,
      }
    );
    assert.equal(res.code, 1);
    assert.match(res.stderr, /CF_API_TOKEN/);
    assert.doesNotMatch(res.stdout, new RegExp(SENTINEL_TOKEN));
    assert.doesNotMatch(res.stderr, new RegExp(SENTINEL_TOKEN));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('edge dns without CF_API_TOKEN exits 1 with a clear error and prints no token', async () => {
  const tmpDir = await createTempDir('edgectl-edge-notoken-dns-');
  try {
    const res = await runEdgectl(
      ['edge', 'dns', 'app.example.com', '--target', 'tunnel.cfargotunnel.com'],
      {
        EDGEKIT_STATE_DIR: tmpDir,
        EDGEKIT_DYNAMIC_DIR: undefined,
        EDGEKIT_POLICY: undefined,
        EDGEKIT_ENABLED: undefined,
        CF_API_TOKEN: undefined,
      }
    );
    assert.equal(res.code, 1);
    assert.match(res.stderr, /CF_API_TOKEN/);
    assert.doesNotMatch(res.stdout, new RegExp(SENTINEL_TOKEN));
    assert.doesNotMatch(res.stderr, new RegExp(SENTINEL_TOKEN));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('edge access without CF_API_TOKEN exits 1 with a clear error and prints no token', async () => {
  const tmpDir = await createTempDir('edgectl-edge-notoken-access-');
  try {
    const res = await runEdgectl(
      ['edge', 'access', 'app.example.com', '--name', 'app-access', '--policy', '{"decision":"allow","include":[]}'],
      {
        EDGEKIT_STATE_DIR: tmpDir,
        EDGEKIT_DYNAMIC_DIR: undefined,
        EDGEKIT_POLICY: undefined,
        EDGEKIT_ENABLED: undefined,
        CF_API_TOKEN: undefined,
      }
    );
    assert.equal(res.code, 1);
    assert.match(res.stderr, /CF_API_TOKEN/);
    assert.doesNotMatch(res.stdout, new RegExp(SENTINEL_TOKEN));
    assert.doesNotMatch(res.stderr, new RegExp(SENTINEL_TOKEN));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('edge ingress requires a hostname: exits 2, no CF env needed', async () => {
  const tmpDir = await createTempDir('edgectl-edge-nohost-');
  try {
    const res = await runEdgectl(['edge', 'ingress'], {
      EDGEKIT_STATE_DIR: tmpDir,
      EDGEKIT_DYNAMIC_DIR: undefined,
      EDGEKIT_POLICY: undefined,
      EDGEKIT_ENABLED: undefined,
      CF_API_TOKEN: undefined,
    });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /hostname/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('edge ingress missing --service exits 2 before any CF_* env is required', async () => {
  const tmpDir = await createTempDir('edgectl-edge-noservice-');
  try {
    const res = await runEdgectl(['edge', 'ingress', 'app.example.com'], {
      EDGEKIT_STATE_DIR: tmpDir,
      EDGEKIT_DYNAMIC_DIR: undefined,
      EDGEKIT_POLICY: undefined,
      EDGEKIT_ENABLED: undefined,
      CF_API_TOKEN: 'does-not-matter',
    });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--service/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('edge commands do not require EDGEKIT_DYNAMIC_DIR or EDGEKIT_POLICY', async () => {
  const tmpDir = await createTempDir('edgectl-edge-nolocalstate-');
  try {
    // Missing CF_ACCOUNT_ID/CF_TUNNEL_ID, but only EDGEKIT_STATE_DIR (required by the
    // bin/edgectl flock wrapper itself) is set among the local-state env vars; the
    // command must get past the local-state gate and fail on CF config, not on
    // EDGEKIT_DYNAMIC_DIR/EDGEKIT_POLICY being unset.
    const res = await runEdgectl(
      ['edge', 'ingress', 'app.example.com', '--service', 'http://10.0.0.5:8080'],
      {
        EDGEKIT_STATE_DIR: tmpDir,
        EDGEKIT_DYNAMIC_DIR: undefined,
        EDGEKIT_POLICY: undefined,
        EDGEKIT_ENABLED: undefined,
        CF_API_TOKEN: 'fake-test-token',
      }
    );
    assert.equal(res.code, 1);
    assert.match(res.stderr, /CF_ACCOUNT_ID/);
    assert.doesNotMatch(res.stderr, /EDGEKIT_DYNAMIC_DIR|EDGEKIT_POLICY/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
