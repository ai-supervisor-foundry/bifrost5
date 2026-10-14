import test from 'node:test';
import assert from 'node:assert/strict';
import { runEdgeAccess, runEdgeDns, runEdgeIngress } from '../../src/cli/edgeCommands.ts';
import type {
  AccessPolicy,
  AccessPort,
  DnsPort,
  TunnelIngressPort,
} from '../../src/domain/ports.ts';

/**
 * A port whose "mutating" branch (opts.dryRun === false) throws instead of
 * doing anything. Used to prove the dry-run path never reaches that branch:
 * if it did, these tests would fail on the throw rather than on an assertion.
 */
function makeThrowingIngressPort(): TunnelIngressPort {
  return {
    async addHost(hostname, service, opts) {
      if (!opts.dryRun) {
        throw new Error('mutation attempted: addHost called with dryRun=false');
      }
      return { changed: true, diff: `+ ${hostname} -> ${service}` };
    },
    async removeHost() {
      throw new Error('mutation attempted: removeHost called');
    },
  };
}

function makeThrowingDnsPort(): DnsPort {
  return {
    async ensureCname(hostname, target, opts) {
      if (!opts.dryRun) {
        throw new Error('mutation attempted: ensureCname called with dryRun=false');
      }
      return { changed: true, diff: `+ ${hostname} CNAME ${target}` };
    },
    async removeCname() {
      throw new Error('mutation attempted: removeCname called');
    },
  };
}

function makeThrowingAccessPort(): AccessPort {
  return {
    async list() {
      return [];
    },
    async ensure(hostname, name, policy, opts) {
      if (!opts.dryRun) {
        throw new Error('mutation attempted: ensure called with dryRun=false');
      }
      return { changed: true, diff: `+ ${hostname} AccessApp ${name}` };
    },
    async remove() {
      throw new Error('mutation attempted: remove called');
    },
  };
}

function makeCountingIngressPort(): { port: TunnelIngressPort; calls: Array<{ dryRun: boolean }> } {
  const calls: Array<{ dryRun: boolean }> = [];
  const port: TunnelIngressPort = {
    async addHost(hostname, service, opts) {
      calls.push({ dryRun: opts.dryRun });
      return { changed: true, diff: `+ ${hostname} -> ${service}` };
    },
    async removeHost() {
      throw new Error('not used in this test');
    },
  };
  return { port, calls };
}

function makeCountingDnsPort(): { port: DnsPort; calls: Array<{ dryRun: boolean }> } {
  const calls: Array<{ dryRun: boolean }> = [];
  const port: DnsPort = {
    async ensureCname(hostname, target, opts) {
      calls.push({ dryRun: opts.dryRun });
      return { changed: true, diff: `+ ${hostname} CNAME ${target}` };
    },
    async removeCname() {
      throw new Error('not used in this test');
    },
  };
  return { port, calls };
}

function makeCountingAccessPort(): { port: AccessPort; calls: Array<{ dryRun: boolean }> } {
  const calls: Array<{ dryRun: boolean }> = [];
  const port: AccessPort = {
    async list() {
      return [];
    },
    async ensure(hostname, name, policy, opts) {
      calls.push({ dryRun: opts.dryRun });
      return { changed: true, diff: `+ ${hostname} AccessApp ${name}` };
    },
    async remove() {
      throw new Error('not used in this test');
    },
  };
  return { port, calls };
}

const SAMPLE_POLICY: AccessPolicy = {
  decision: 'allow',
  include: [{ email_domain: { domain: 'example.com' } }],
};

test('edge ingress dry-run prints a diff and never mutates', async () => {
  const port = makeThrowingIngressPort();
  const result = await runEdgeIngress(port, 'app.example.com', 'http://10.0.0.5:8080', false);
  assert.equal(result.applied, false);
  assert.equal(result.changed, true);
  assert.match(result.diff ?? '', /app\.example\.com/);
});

test('edge ingress --apply calls addHost exactly once with dryRun=false', async () => {
  const { port, calls } = makeCountingIngressPort();
  const result = await runEdgeIngress(port, 'app.example.com', 'http://10.0.0.5:8080', true);
  assert.equal(result.applied, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, false);
});

test('edge dns dry-run prints a diff and never mutates', async () => {
  const port = makeThrowingDnsPort();
  const result = await runEdgeDns(port, 'app.example.com', 'tunnel.cfargotunnel.com', false);
  assert.equal(result.applied, false);
  assert.equal(result.changed, true);
  assert.match(result.diff ?? '', /app\.example\.com/);
});

test('edge dns --apply calls ensureCname exactly once with dryRun=false', async () => {
  const { port, calls } = makeCountingDnsPort();
  const result = await runEdgeDns(port, 'app.example.com', 'tunnel.cfargotunnel.com', true);
  assert.equal(result.applied, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, false);
});

test('edge access dry-run prints a diff and never mutates', async () => {
  const port = makeThrowingAccessPort();
  const result = await runEdgeAccess(port, 'app.example.com', 'app-access', SAMPLE_POLICY, false);
  assert.equal(result.applied, false);
  assert.equal(result.changed, true);
  assert.match(result.diff ?? '', /app\.example\.com/);
});

test('edge access --apply calls ensure exactly once with dryRun=false', async () => {
  const { port, calls } = makeCountingAccessPort();
  const result = await runEdgeAccess(port, 'app.example.com', 'app-access', SAMPLE_POLICY, true);
  assert.equal(result.applied, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, false);
});
