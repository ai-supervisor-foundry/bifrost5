import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';

async function loadCompose() {
  const composePath = path.resolve(process.cwd(), 'compose.yml');
  const content = await fs.readFile(composePath, 'utf8');
  return parse(content);
}

test('edgekit-net is external', async () => {
  const compose = await loadCompose();

  const network = compose.networks?.['edgekit-net'];
  assert.ok(network, 'edgekit-net network must be defined in compose.yml');
  assert.equal(network.external, true, 'edgekit-net must be external so compose never recreates it');
  assert.equal(network.name, 'edgekit-net', 'edgekit-net must keep the name edgekit-net');
});
