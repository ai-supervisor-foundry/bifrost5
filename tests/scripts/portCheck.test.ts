import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'port-check.sh');

function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runPortCheck(
  env: Record<string, string | undefined>,
  shimDir: string
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(SCRIPT, [], {
      env: {
        ...process.env,
        ...env,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
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
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeSsStub(shimDir: string, output: string): Promise<void> {
  const ssPath = path.join(shimDir, 'ss');
  await fs.writeFile(ssPath, `#!/usr/bin/env bash\ncat <<'SS_OUTPUT'\n${output}\nSS_OUTPUT\n`, {
    mode: 0o755,
  });
  // Stub docker too, so results never depend on containers running on the host.
  const dockerPath = path.join(shimDir, 'docker');
  await fs.writeFile(dockerPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
}

test('port-check.sh is executable', async () => {
  const stat = await fs.stat(SCRIPT);
  assert.ok(stat.mode & 0o111, 'expected scripts/port-check.sh to be executable');
});

test('loopback-only ss output exits 0', async () => {
  const shimDir = await createTempDir('port-check-loopback-');
  try {
    await writeSsStub(
      shimDir,
      [
        'LISTEN 0      511        127.0.0.1:18080 0.0.0.0:*',
        'LISTEN 0      511        127.0.0.1:18081 0.0.0.0:*',
      ].join('\n')
    );

    const res = await runPortCheck({}, shimDir);

    assert.equal(res.code, 0, `Expected exit 0, got ${res.code}. stdout: ${res.stdout}`);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('a 0.0.0.0 bind on a kit port exits 1', async () => {
  const shimDir = await createTempDir('port-check-wildcard-');
  try {
    await writeSsStub(
      shimDir,
      [
        'LISTEN 0      511          0.0.0.0:18080 0.0.0.0:*',
        'LISTEN 0      511        127.0.0.1:18081 0.0.0.0:*',
      ].join('\n')
    );

    const res = await runPortCheck({}, shimDir);

    assert.equal(res.code, 1, `Expected exit 1, got ${res.code}. stdout: ${res.stdout}`);
    assert.match(res.stdout, /18080/);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('a [::] bind on a kit port exits 1', async () => {
  const shimDir = await createTempDir('port-check-ipv6-wildcard-');
  try {
    await writeSsStub(
      shimDir,
      ['LISTEN 0      511             [::]:18081             [::]:*'].join('\n')
    );

    const res = await runPortCheck({}, shimDir);

    assert.equal(res.code, 1, `Expected exit 1, got ${res.code}. stdout: ${res.stdout}`);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('non-kit ports bound to 0.0.0.0 do not affect the exit code', async () => {
  const shimDir = await createTempDir('port-check-other-ports-');
  try {
    await writeSsStub(
      shimDir,
      [
        'LISTEN 0      511          0.0.0.0:22 0.0.0.0:*',
        'LISTEN 0      511        127.0.0.1:18080 0.0.0.0:*',
        'LISTEN 0      511        127.0.0.1:18081 0.0.0.0:*',
      ].join('\n')
    );

    const res = await runPortCheck({}, shimDir);

    assert.equal(res.code, 0, `Expected exit 0, got ${res.code}. stdout: ${res.stdout}`);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('EDGEKIT_PORTS overrides the default kit port list', async () => {
  const shimDir = await createTempDir('port-check-custom-ports-');
  try {
    await writeSsStub(shimDir, ['LISTEN 0      511          0.0.0.0:9999 0.0.0.0:*'].join('\n'));

    const defaultPorts = await runPortCheck({}, shimDir);
    assert.equal(
      defaultPorts.code,
      0,
      `port 9999 is not a default kit port, expected exit 0. stdout: ${defaultPorts.stdout}`
    );

    const customPorts = await runPortCheck({ EDGEKIT_PORTS: '9999' }, shimDir);
    assert.equal(
      customPorts.code,
      1,
      `port 9999 named via EDGEKIT_PORTS, expected exit 1. stdout: ${customPorts.stdout}`
    );
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('prints at most 10 lines even with many kit ports bound to 0.0.0.0', async () => {
  const shimDir = await createTempDir('port-check-line-cap-');
  try {
    const ports = Array.from({ length: 20 }, (_, i) => 20000 + i);
    await writeSsStub(
      shimDir,
      ports.map((p) => `LISTEN 0      511          0.0.0.0:${p} 0.0.0.0:*`).join('\n')
    );

    const res = await runPortCheck({ EDGEKIT_PORTS: ports.join(',') }, shimDir);

    assert.equal(res.code, 1, `Expected exit 1, got ${res.code}. stdout: ${res.stdout}`);
    const lineCount = res.stdout.split('\n').filter((l) => l.length > 0).length;
    assert.ok(lineCount <= 10, `Expected at most 10 lines, got ${lineCount}:\n${res.stdout}`);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});

test('never invokes sudo', async () => {
  const contents = await fs.readFile(SCRIPT, 'utf8');
  const codeLines = contents
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'));
  for (const line of codeLines) {
    assert.doesNotMatch(line, /\bsudo\b/, `found a sudo call: ${line}`);
  }
});

test('ufw requiring root is reported as unknown, not a failure', async () => {
  const shimDir = await createTempDir('port-check-ufw-');
  try {
    await writeSsStub(shimDir, 'LISTEN 0      511        127.0.0.1:18080 0.0.0.0:*');
    const ufwPath = path.join(shimDir, 'ufw');
    await fs.writeFile(
      ufwPath,
      '#!/usr/bin/env bash\necho "ERROR: You need to be root to run this script" >&2\nexit 1\n',
      { mode: 0o755 }
    );

    const res = await runPortCheck({}, shimDir);

    assert.equal(res.code, 0, `Expected exit 0, got ${res.code}. stdout: ${res.stdout}`);
    assert.match(res.stdout, /ufw: unknown/);
  } finally {
    await fs.rm(shimDir, { recursive: true, force: true });
  }
});
