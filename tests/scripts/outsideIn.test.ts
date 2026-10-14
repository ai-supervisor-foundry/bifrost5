import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'outside-in.sh');

function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(SCRIPT, args, { env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Stubs nmap on PATH with scan output, alongside the real PATH so bash/env
// and other shell basics are still resolvable.
async function withStubNmap(scanOutput: string): Promise<{ shimDir: string; env: Record<string, string> }> {
  const shimDir = await createTempDir('outside-in-nmap-');
  const nmapPath = path.join(shimDir, 'nmap');
  await fs.writeFile(nmapPath, `#!/usr/bin/env bash\ncat <<'NMAP_OUTPUT'\n${scanOutput}\nNMAP_OUTPUT\n`, {
    mode: 0o755,
  });
  return { shimDir, env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` } as Record<string, string> };
}

// Builds a PATH with only the binaries bash needs to run the script's
// shebang and builtins, deliberately excluding nmap even though the real
// host may have it installed elsewhere on PATH.
async function withoutNmap(): Promise<{ dir: string; env: Record<string, string> }> {
  const dir = await createTempDir('outside-in-no-nmap-');
  for (const bin of ['bash', 'env']) {
    const real = await new Promise<string>((resolve, reject) => {
      const proc = spawn('/bin/sh', ['-c', `command -v ${bin}`]);
      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${bin} not found`))));
    });
    await fs.symlink(real, path.join(dir, bin));
  }
  return { dir, env: { ...process.env, PATH: dir } as Record<string, string> };
}

const SCAN_PORT_22_OPEN = [
  'Starting Nmap 7.94 ( https://nmap.org )',
  'Nmap scan report for example.com (203.0.113.10)',
  'Host is up (0.0010s latency).',
  'Not shown: 65533 closed ports',
  'PORT    STATE SERVICE',
  '22/tcp  open  ssh',
  '443/tcp open  https',
  '',
  'Nmap done: 1 IP address (1 host up) scanned in 4.21 seconds',
].join('\n');

const SCAN_NONE_OPEN = [
  'Starting Nmap 7.94 ( https://nmap.org )',
  'Nmap scan report for example.com (203.0.113.10)',
  'Host is up (0.0010s latency).',
  'All 65535 scanned ports on example.com (203.0.113.10) are in ignored states.',
  'Not shown: 65535 filtered ports',
  '',
  'Nmap done: 1 IP address (1 host up) scanned in 4.21 seconds',
].join('\n');

const SCAN_443_OPEN_ONLY = [
  'Starting Nmap 7.94 ( https://nmap.org )',
  'Nmap scan report for example.com (203.0.113.10)',
  'Host is up (0.0010s latency).',
  'Not shown: 65534 closed ports',
  'PORT    STATE SERVICE',
  '443/tcp open  https',
  '',
  'Nmap done: 1 IP address (1 host up) scanned in 4.21 seconds',
].join('\n');

test('outside-in.sh is executable', async () => {
  const stat = await fs.stat(SCRIPT);
  assert.ok(stat.mode & 0o111, 'expected scripts/outside-in.sh to be executable');
});

test('an open port outside the allowed list exits 1', async () => {
  const { shimDir, env } = await withStubNmap(SCAN_PORT_22_OPEN);
  try {
    const res = await run(['example.com'], env);
    assert.equal(res.code, 1, `Expected exit 1, got ${res.code}. stdout: ${res.stdout}`);
    assert.match(res.stdout, /\b22\b/);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('only the default allowed port (443) open exits 0', async () => {
  const { shimDir, env } = await withStubNmap(SCAN_443_OPEN_ONLY);
  try {
    const res = await run(['example.com'], env);
    assert.equal(res.code, 0, `Expected exit 0, got ${res.code}. stdout: ${res.stdout}`);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('no open ports exits 0', async () => {
  const { shimDir, env } = await withStubNmap(SCAN_NONE_OPEN);
  try {
    const res = await run(['example.com'], env);
    assert.equal(res.code, 0, `Expected exit 0, got ${res.code}. stdout: ${res.stdout}`);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('a custom allowed-ports list is honored', async () => {
  const { shimDir, env } = await withStubNmap(SCAN_PORT_22_OPEN);
  try {
    const res = await run(['example.com', '22,443'], env);
    assert.equal(res.code, 0, `Expected exit 0, got ${res.code}. stdout: ${res.stdout}`);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('missing nmap exits 2', async () => {
  const { dir, env } = await withoutNmap();
  try {
    const res = await run(['example.com'], env);
    assert.equal(res.code, 2, `Expected exit 2, got ${res.code}. stdout: ${res.stdout} stderr: ${res.stderr}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('missing target argument exits 2', async () => {
  const { shimDir, env } = await withStubNmap(SCAN_NONE_OPEN);
  try {
    const res = await run([], env);
    assert.equal(res.code, 2, `Expected exit 2, got ${res.code}. stdout: ${res.stdout}`);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('prints at most 10 lines even with many open ports', async () => {
  const manyOpen = [
    'Starting Nmap 7.94 ( https://nmap.org )',
    'Nmap scan report for example.com (203.0.113.10)',
    'Host is up (0.0010s latency).',
    'PORT    STATE SERVICE',
    ...Array.from({ length: 20 }, (_, i) => `${20000 + i}/tcp open  unknown`),
    '',
    'Nmap done: 1 IP address (1 host up) scanned in 4.21 seconds',
  ].join('\n');
  const { shimDir, env } = await withStubNmap(manyOpen);
  try {
    const res = await run(['example.com'], env);
    assert.equal(res.code, 1, `Expected exit 1, got ${res.code}. stdout: ${res.stdout}`);
    const lineCount = res.stdout.split('\n').filter((l) => l.length > 0).length;
    assert.ok(lineCount <= 10, `Expected at most 10 lines, got ${lineCount}:\n${res.stdout}`);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});
