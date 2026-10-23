import test from 'node:test';
import assert from 'node:assert/strict';

import { DockerTargetResolver } from '../../src/adapters/dockerTargetResolver.ts';

const inspect = JSON.stringify([
  {
    Name: 'edgekit-net',
    IPAM: { Config: [{ Subnet: '10.20.0.0/16' }] },
    Containers: {
      a1: { Name: 'blog-app', IPv4Address: '10.20.0.5/16', Aliases: ['blog-app', 'web'] },
      b2: { Name: 'other', IPv4Address: '10.20.0.6/16', Aliases: ['other'] },
      c3: { Name: 'noalias', IPv4Address: '10.20.0.7/16' },
    },
  },
]);

test('resolver returns containers whose aliases include the alias', async () => {
  let args: string[] = [];
  const r = new DockerTargetResolver({ run: async (a) => { args = a; return inspect; } });
  const out = await r.resolve('web');
  assert.deepEqual(args, ['network', 'inspect', 'edgekit-net']);
  assert.equal(out.length, 1);
  assert.equal(out[0].ip, '10.20.0.5');
  assert.equal(out[0].container, 'blog-app');
  assert.equal(out[0].subnet, '10.20.0.0/16');
});

test('resolver falls back to container name when no aliases', async () => {
  const r = new DockerTargetResolver({ run: async () => inspect });
  const out = await r.resolve('noalias');
  assert.deepEqual(out.map(o => o.ip), ['10.20.0.7']);
});

test('resolver returns empty for unknown alias and honours network', async () => {
  let args: string[] = [];
  const r = new DockerTargetResolver({ network: 'x', run: async (a) => { args = a; return inspect; } });
  assert.deepEqual(await r.resolve('nope'), []);
  assert.equal(args[2], 'x');
});

test('resolver returns empty when network is missing', async () => {
  const r = new DockerTargetResolver({ run: async () => '[]' });
  assert.deepEqual(await r.resolve('web'), []);
});
