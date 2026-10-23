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
  const r = new DockerTargetResolver({ run: async (a) => { if (a[0] === 'network') args = a; return inspect; } });
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
  const r = new DockerTargetResolver({ network: 'x', run: async (a) => { if (a[0] === 'network') args = a; return inspect; } });
  assert.deepEqual(await r.resolve('nope'), []);
  assert.equal(args[2], 'x');
});

test('resolver returns empty when network is missing', async () => {
  const r = new DockerTargetResolver({ run: async () => '[]' });
  assert.deepEqual(await r.resolve('web'), []);
});

// Real `docker network inspect` carries no aliases or labels per container;
// they only appear in `docker inspect <container>` under the network endpoint.
test('resolver reads aliases and labels from docker inspect when network inspect has none', async () => {
  const netOut = JSON.stringify([
    {
      IPAM: { Config: [{ Subnet: '10.20.0.0/16' }] },
      Containers: {
        id1: { Name: 'app-1', IPv4Address: '10.20.0.5/16' },
        id2: { Name: 'other', IPv4Address: '10.20.0.6/16' },
      },
    },
  ]);
  const ctrOut = JSON.stringify([
    {
      Id: 'id1',
      Name: '/app-1',
      Config: { Labels: { 'edgekit.owner': 'alice' } },
      NetworkSettings: { Networks: { 'edgekit-net': { Aliases: ['app--x', 'id1short'] } } },
    },
    {
      Id: 'id2',
      Name: '/other',
      Config: { Labels: {} },
      NetworkSettings: { Networks: { 'edgekit-net': { Aliases: null } } },
    },
  ]);
  const calls: string[][] = [];
  const r = new DockerTargetResolver({
    run: async (a) => {
      calls.push(a);
      return a[0] === 'network' ? netOut : ctrOut;
    },
  });
  const out = await r.resolve('app--x');
  assert.equal(out.length, 1);
  assert.equal(out[0].ip, '10.20.0.5');
  assert.equal(out[0].container, 'app-1');
  assert.equal(out[0].labels?.['edgekit.owner'], 'alice');
  assert.deepEqual(calls[1], ['inspect', 'id1', 'id2']);
  assert.deepEqual((await r.resolve('other')).map(o => o.ip), ['10.20.0.6']);
});
