import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

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

const SAMPLE_POLICY = {
  reservedOwners: ['foundry*', 'apps', 'admin', 'api', 'control', 'connect'],
  allowedHosts: ['sites.example.com', 'test.example.com'],
  ownerCidrs: {
    alice: ['10.20.0.0/16'],
    bob: ['10.30.0.0/16'],
  },
  publicOwners: ['bob'],
};

test('register ok writes <id>.yml and desired json', async () => {
  const tmpDir = await createTempDir('edgectl-test-reg-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');
  const policyFile = path.join(tmpDir, 'policy.json');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.writeFile(policyFile, JSON.stringify(SAMPLE_POLICY, null, 2));

    const res = await runEdgectl(
      [
        'register',
        '--owner',
        'alice',
        '--name',
        'blog',
        '--host',
        'sites.example.com',
        '--target',
        'http://10.20.0.5:3000',
      ],
      {
        EDGEKIT_STATE_DIR: stateDir,
        EDGEKIT_DYNAMIC_DIR: dynamicDir,
        EDGEKIT_POLICY: policyFile,
        EDGEKIT_ENABLED: '1',
      }
    );

    assert.equal(res.code, 0, `Expected exit 0, got ${res.code}. stderr: ${res.stderr}`);

    // Verify desired JSON
    const desiredPath = path.join(stateDir, 'desired', 'alice', 'alice--blog.json');
    const desiredRaw = await fs.readFile(desiredPath, 'utf8');
    const desiredJson = JSON.parse(desiredRaw);
    assert.equal(desiredJson.id, 'alice--blog');
    assert.equal(desiredJson.owner, 'alice');
    assert.equal(desiredJson.host, 'sites.example.com');
    assert.equal(desiredJson.pathPrefix, '/p/alice--blog/');
    assert.equal(desiredJson.target, 'http://10.20.0.5:3000');
    assert.equal(desiredJson.access, 'private');
    assert.equal(desiredJson.stripPrefix, true);

    // Verify dynamic <id>.yml
    const dynamicPath = path.join(dynamicDir, 'alice--blog.yml');
    const dynamicRaw = await fs.readFile(dynamicPath, 'utf8');
    const dynamicYaml = parseYaml(dynamicRaw);
    assert.ok(dynamicYaml.http);
    assert.ok(dynamicYaml.http.routers['alice--blog']);

    // Check stdout is JSON of the spec
    const stdoutJson = JSON.parse(res.stdout);
    assert.deepEqual(stdoutJson, desiredJson);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('register twice = same output and one file', async () => {
  const tmpDir = await createTempDir('edgectl-test-regtwice-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');
  const policyFile = path.join(tmpDir, 'policy.json');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.writeFile(policyFile, JSON.stringify(SAMPLE_POLICY, null, 2));

    const env = {
      EDGEKIT_STATE_DIR: stateDir,
      EDGEKIT_DYNAMIC_DIR: dynamicDir,
      EDGEKIT_POLICY: policyFile,
      EDGEKIT_ENABLED: '1',
    };

    const cmd = [
      'register',
      '--owner',
      'alice',
      '--name',
      'blog',
      '--host',
      'sites.example.com',
      '--target',
      'http://10.20.0.5:3000',
    ];

    const res1 = await runEdgectl(cmd, env);
    assert.equal(res1.code, 0);

    const res2 = await runEdgectl(cmd, env);
    assert.equal(res2.code, 0);
    assert.equal(res2.stdout, res1.stdout);

    // Verify exactly one json file and one yml file
    const desiredFiles = await fs.readdir(path.join(stateDir, 'desired', 'alice'));
    assert.deepEqual(desiredFiles, ['alice--blog.json']);

    const dynamicFiles = await fs.readdir(dynamicDir);
    assert.deepEqual(dynamicFiles, ['alice--blog.yml']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('foundry--x refused exit 2 and no files', async () => {
  const tmpDir = await createTempDir('edgectl-test-reserved-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');
  const policyFile = path.join(tmpDir, 'policy.json');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.writeFile(policyFile, JSON.stringify(SAMPLE_POLICY, null, 2));

    const res = await runEdgectl(
      [
        'register',
        '--owner',
        'foundry',
        '--name',
        'x',
        '--host',
        'sites.example.com',
        '--target',
        'http://10.20.0.5:3000',
      ],
      {
        EDGEKIT_STATE_DIR: stateDir,
        EDGEKIT_DYNAMIC_DIR: dynamicDir,
        EDGEKIT_POLICY: policyFile,
        EDGEKIT_ENABLED: '1',
      }
    );

    assert.equal(res.code, 2);
    assert.match(res.stderr, /reserved pattern/);

    // Verify nothing written
    const dynamicFiles = await fs.readdir(dynamicDir);
    assert.deepEqual(dynamicFiles, []);

    // Desired directory should not contain any files or not exist
    try {
      const desiredFiles = await fs.readdir(path.join(stateDir, 'desired'));
      assert.deepEqual(desiredFiles, []);
    } catch (e: any) {
      assert.equal(e.code, 'ENOENT');
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('hyphenated owner refused', async () => {
  const tmpDir = await createTempDir('edgectl-test-badowner-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');
  const policyFile = path.join(tmpDir, 'policy.json');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.writeFile(policyFile, JSON.stringify(SAMPLE_POLICY, null, 2));

    const res = await runEdgectl(
      [
        'register',
        '--owner',
        'alice-bob',
        '--name',
        'app',
        '--host',
        'sites.example.com',
        '--target',
        'http://10.20.0.5:3000',
      ],
      {
        EDGEKIT_STATE_DIR: stateDir,
        EDGEKIT_DYNAMIC_DIR: dynamicDir,
        EDGEKIT_POLICY: policyFile,
        EDGEKIT_ENABLED: '1',
      }
    );

    assert.equal(res.code, 2);
    assert.match(res.stderr, /owner must match/);

    // Verify nothing written
    const dynamicFiles = await fs.readdir(dynamicDir);
    assert.deepEqual(dynamicFiles, []);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('disabled flag exit 3', async () => {
  const tmpDir = await createTempDir('edgectl-test-disabled-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');
  const policyFile = path.join(tmpDir, 'policy.json');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.writeFile(policyFile, JSON.stringify(SAMPLE_POLICY, null, 2));

    // 1. register when EDGEKIT_ENABLED is unset (defaults to 0)
    const resUnset = await runEdgectl(
      [
        'register',
        '--owner',
        'alice',
        '--name',
        'blog',
        '--host',
        'sites.example.com',
        '--target',
        'http://10.20.0.5:3000',
      ],
      {
        EDGEKIT_STATE_DIR: stateDir,
        EDGEKIT_DYNAMIC_DIR: dynamicDir,
        EDGEKIT_POLICY: policyFile,
        EDGEKIT_ENABLED: undefined,
      }
    );
    assert.equal(resUnset.code, 3);
    assert.equal(resUnset.stderr.trim(), 'edgekit disabled');

    // 2. register when EDGEKIT_ENABLED='0'
    const resZero = await runEdgectl(
      [
        'register',
        '--owner',
        'alice',
        '--name',
        'blog',
        '--host',
        'sites.example.com',
        '--target',
        'http://10.20.0.5:3000',
      ],
      {
        EDGEKIT_STATE_DIR: stateDir,
        EDGEKIT_DYNAMIC_DIR: dynamicDir,
        EDGEKIT_POLICY: policyFile,
        EDGEKIT_ENABLED: '0',
      }
    );
    assert.equal(resZero.code, 3);
    assert.equal(resZero.stderr.trim(), 'edgekit disabled');

    // 3. unregister when disabled
    const resUnreg = await runEdgectl(['unregister', 'alice--blog'], {
      EDGEKIT_STATE_DIR: stateDir,
      EDGEKIT_DYNAMIC_DIR: dynamicDir,
      EDGEKIT_POLICY: policyFile,
      EDGEKIT_ENABLED: '0',
    });
    assert.equal(resUnreg.code, 3);
    assert.equal(resUnreg.stderr.trim(), 'edgekit disabled');

    // 4. reconcile when disabled
    const resRec = await runEdgectl(['reconcile'], {
      EDGEKIT_STATE_DIR: stateDir,
      EDGEKIT_DYNAMIC_DIR: dynamicDir,
      EDGEKIT_POLICY: policyFile,
      EDGEKIT_ENABLED: '0',
    });
    assert.equal(resRec.code, 3);
    assert.equal(resRec.stderr.trim(), 'edgekit disabled');

    // 5. list still works when disabled
    const resList = await runEdgectl(['list'], {
      EDGEKIT_STATE_DIR: stateDir,
      EDGEKIT_DYNAMIC_DIR: dynamicDir,
      EDGEKIT_POLICY: policyFile,
      EDGEKIT_ENABLED: '0',
    });
    assert.equal(resList.code, 0);
    assert.deepEqual(JSON.parse(resList.stdout), []);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('unregister removes both', async () => {
  const tmpDir = await createTempDir('edgectl-test-unreg-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');
  const policyFile = path.join(tmpDir, 'policy.json');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.writeFile(policyFile, JSON.stringify(SAMPLE_POLICY, null, 2));

    const env = {
      EDGEKIT_STATE_DIR: stateDir,
      EDGEKIT_DYNAMIC_DIR: dynamicDir,
      EDGEKIT_POLICY: policyFile,
      EDGEKIT_ENABLED: '1',
    };

    // Register first
    const resReg = await runEdgectl(
      [
        'register',
        '--owner',
        'alice',
        '--name',
        'blog',
        '--host',
        'sites.example.com',
        '--target',
        'http://10.20.0.5:3000',
      ],
      env
    );
    assert.equal(resReg.code, 0);

    const desiredPath = path.join(stateDir, 'desired', 'alice', 'alice--blog.json');
    const dynamicPath = path.join(dynamicDir, 'alice--blog.yml');

    assert.ok(await fs.stat(desiredPath));
    assert.ok(await fs.stat(dynamicPath));

    // Unregister
    const resUnreg = await runEdgectl(['unregister', 'alice--blog'], env);
    assert.equal(resUnreg.code, 0);

    // Verify both files removed
    await assert.rejects(fs.stat(desiredPath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(dynamicPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('unregister with invalid id prints error to stderr and exits 2', async () => {
  const tmpDir = await createTempDir('edgectl-test-unreg-invalid-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');
  const policyFile = path.join(tmpDir, 'policy.json');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.writeFile(policyFile, JSON.stringify(SAMPLE_POLICY, null, 2));

    const env = {
      EDGEKIT_STATE_DIR: stateDir,
      EDGEKIT_DYNAMIC_DIR: dynamicDir,
      EDGEKIT_POLICY: policyFile,
      EDGEKIT_ENABLED: '1',
    };

    const res = await runEdgectl(['unregister', 'security'], env);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /Validation failed/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('reconcile removes an orphan .yml placed in the dynamic dir', async () => {
  const tmpDir = await createTempDir('edgectl-test-reconcile-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');
  const policyFile = path.join(tmpDir, 'policy.json');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.writeFile(policyFile, JSON.stringify(SAMPLE_POLICY, null, 2));

    const env = {
      EDGEKIT_STATE_DIR: stateDir,
      EDGEKIT_DYNAMIC_DIR: dynamicDir,
      EDGEKIT_POLICY: policyFile,
      EDGEKIT_ENABLED: '1',
    };

    // 1. Register a legitimate route
    const resReg = await runEdgectl(
      [
        'register',
        '--owner',
        'alice',
        '--name',
        'legit',
        '--host',
        'sites.example.com',
        '--target',
        'http://10.20.0.5:3000',
      ],
      env
    );
    assert.equal(resReg.code, 0);

    // 2. Place an orphan file in dynamicDir
    const orphanPath = path.join(dynamicDir, 'orphan--stray.yml');
    await fs.writeFile(orphanPath, 'dummy yaml');

    // 3. Run reconcile
    const resReconcile = await runEdgectl(['reconcile'], env);
    assert.equal(resReconcile.code, 0);

    // Verify orphan was removed
    await assert.rejects(fs.stat(orphanPath), { code: 'ENOENT' });

    // Verify legitimate file is still there
    const legitDynamicPath = path.join(dynamicDir, 'alice--legit.yml');
    assert.ok(await fs.stat(legitDynamicPath));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('8 parallel registers of distinct names all succeed, every .yml parses as YAML and every desired json parses, and no .tmp files remain', async () => {
  const tmpDir = await createTempDir('edgectl-test-parallel-');
  const stateDir = path.join(tmpDir, 'state');
  const dynamicDir = path.join(tmpDir, 'dynamic');
  const policyFile = path.join(tmpDir, 'policy.json');

  try {
    await fs.mkdir(dynamicDir, { recursive: true });
    await fs.writeFile(policyFile, JSON.stringify(SAMPLE_POLICY, null, 2));

    const env = {
      EDGEKIT_STATE_DIR: stateDir,
      EDGEKIT_DYNAMIC_DIR: dynamicDir,
      EDGEKIT_POLICY: policyFile,
      EDGEKIT_ENABLED: '1',
    };

    const names = ['app1', 'app2', 'app3', 'app4', 'app5', 'app6', 'app7', 'app8'];

    const promises = names.map((name, i) =>
      runEdgectl(
        [
          'register',
          '--owner',
          'alice',
          '--name',
          name,
          '--host',
          'sites.example.com',
          '--target',
          `http://10.20.0.${i + 1}:3000`,
        ],
        env
      )
    );

    const results = await Promise.all(promises);

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      assert.equal(
        res.code,
        0,
        `Process for ${names[i]} failed with code ${res.code}: ${res.stderr}`
      );
    }

    // Verify all 8 desired json files parse
    for (const name of names) {
      const id = `alice--${name}`;
      const jsonPath = path.join(stateDir, 'desired', 'alice', `${id}.json`);
      const raw = await fs.readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.id, id);
      assert.equal(parsed.owner, 'alice');

      // Verify all 8 dynamic yml files parse
      const ymlPath = path.join(dynamicDir, `${id}.yml`);
      const rawYml = await fs.readFile(ymlPath, 'utf8');
      const parsedYml = parseYaml(rawYml);
      assert.ok(parsedYml.http.routers[id]);
    }

    // Check no .tmp files remain in stateDir or dynamicDir recursively
    async function assertNoTmpFiles(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await assertNoTmpFiles(fullPath);
        } else {
          assert.equal(
            entry.name.endsWith('.tmp'),
            false,
            `Found unexpected .tmp file: ${fullPath}`
          );
        }
      }
    }

    await assertNoTmpFiles(stateDir);
    await assertNoTmpFiles(dynamicDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
