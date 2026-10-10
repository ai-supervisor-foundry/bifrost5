import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';

test('compose.yml traefik access log configuration and project integrity', async () => {
  const composePath = path.resolve(process.cwd(), 'compose.yml');
  const content = await fs.readFile(composePath, 'utf8');
  const compose = parse(content);

  // Assert project name is still edgekit
  assert.equal(compose.name, 'edgekit', 'compose.yml project name should be edgekit');

  // Assert traefik service exists
  const traefik = compose.services?.traefik;
  assert.ok(traefik, 'traefik service must be defined');

  // Assert command contains the four access log flags
  const expectedFlags = [
    '--accesslog=true',
    '--accesslog.format=json',
    '--accesslog.filepath=/var/log/traefik/access.log',
    '--accesslog.bufferingSize=100',
  ];

  assert.ok(Array.isArray(traefik.command), 'traefik.command must be an array');
  for (const flag of expectedFlags) {
    assert.ok(
      traefik.command.includes(flag),
      `traefik.command should include ${flag}`
    );
  }

  // Assert volume ./logs/traefik:/var/log/traefik
  assert.ok(Array.isArray(traefik.volumes), 'traefik.volumes must be an array');
  assert.ok(
    traefik.volumes.includes('./logs/traefik:/var/log/traefik'),
    'traefik.volumes should include ./logs/traefik:/var/log/traefik'
  );

  // Assert absence of docker.sock anywhere in the compose file content
  assert.equal(
    content.includes('docker.sock'),
    false,
    'compose.yml must not contain any reference to docker.sock'
  );

  // Assert absence of docker provider in traefik command or configuration
  for (const cmd of traefik.command) {
    assert.equal(
      cmd.includes('providers.docker'),
      false,
      `traefik.command must not enable docker provider: found ${cmd}`
    );
  }
});
