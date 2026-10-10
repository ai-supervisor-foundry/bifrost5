import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CloudflareTunnelIngressAdapter,
  TUNNEL_CONFIG_PATH_TEMPLATE,
} from '../../src/adapters/cloudflareIngress.ts';
import {
  CloudflareDnsAdapter,
  DNS_RECORDS_PATH_TEMPLATE,
} from '../../src/adapters/cloudflareDns.ts';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

function createFakeFetch(handlers: {
  onCall: (call: RecordedCall) => { status: number; body: any; statusText?: string };
}) {
  const calls: RecordedCall[] = [];

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method || 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (typeof (init.headers as any).forEach === 'function') {
        (init.headers as any).forEach((val: string, key: string) => {
          headers[key] = val;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k] = v;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    let parsedBody: any;
    if (init?.body) {
      try {
        parsedBody = JSON.parse(String(init.body));
      } catch {
        parsedBody = init.body;
      }
    }

    const recCall: RecordedCall = { url, method, headers, body: parsedBody };
    calls.push(recCall);

    const res = handlers.onCall(recCall);
    const responseBody = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);

    return new Response(responseBody, {
      status: res.status,
      statusText: res.statusText || (res.status === 200 ? 'OK' : 'Error'),
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { fakeFetch, calls };
}

const SECRET_TOKEN = 'secret-cf-token-12345';
const ACCOUNT_ID = 'acc-123';
const TUNNEL_ID = 'tun-456';
const ZONE_ID = 'zone-789';

test('1. merge keeps others and catch-all last', async () => {
  let putSeen = false;
  let finalIngress: any[] = [];

  const initialIngress = [
    { hostname: 'first.example.com', service: 'http://10.0.0.1:8080' },
    { hostname: 'second.example.com', service: 'http://10.0.0.2:8080' },
    { service: 'http_status:404' }, // catch-all
  ];

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return {
          status: 200,
          body: {
            result: {
              config: {
                ingress: initialIngress,
              },
            },
          },
        };
      }
      if (call.method === 'PUT') {
        putSeen = true;
        finalIngress = call.body.config.ingress;
        return { status: 200, body: { success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareTunnelIngressAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    tunnelId: TUNNEL_ID,
    token: SECRET_TOKEN,
  });

  const result = await adapter.addHost('new.example.com', 'http://10.0.0.3:8080');
  assert.equal(result.changed, true);
  assert.equal(putSeen, true);

  assert.equal(finalIngress.length, 4);
  assert.deepEqual(finalIngress[0], { hostname: 'first.example.com', service: 'http://10.0.0.1:8080' });
  assert.deepEqual(finalIngress[1], { hostname: 'second.example.com', service: 'http://10.0.0.2:8080' });
  assert.deepEqual(finalIngress[2], { hostname: 'new.example.com', service: 'http://10.0.0.3:8080' });
  assert.deepEqual(finalIngress[3], { service: 'http_status:404' }); // Catch-all rule is strictly LAST
});

test('2. same host twice = one rule (replaces existing rule, never duplicates)', async () => {
  let putSeen = false;
  let finalIngress: any[] = [];

  const initialIngress = [
    { hostname: 'alice.example.com', service: 'http://10.0.0.1:8080' },
    { hostname: 'bob.example.com', service: 'http://10.0.0.2:8080' },
    { service: 'http_status:404' },
  ];

  const { fakeFetch } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return {
          status: 200,
          body: {
            result: {
              config: {
                ingress: initialIngress,
              },
            },
          },
        };
      }
      if (call.method === 'PUT') {
        putSeen = true;
        finalIngress = call.body.config.ingress;
        return { status: 200, body: { success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareTunnelIngressAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    tunnelId: TUNNEL_ID,
    token: SECRET_TOKEN,
  });

  // Update alice with a new target service
  const res = await adapter.addHost('alice.example.com', 'http://10.0.0.99:9090');
  assert.equal(res.changed, true);
  assert.equal(putSeen, true);

  // Still only 3 rules in total; alice updated in-place, bob kept, catch-all last
  assert.equal(finalIngress.length, 3);
  assert.deepEqual(finalIngress[0], { hostname: 'alice.example.com', service: 'http://10.0.0.99:9090' });
  assert.deepEqual(finalIngress[1], { hostname: 'bob.example.com', service: 'http://10.0.0.2:8080' });
  assert.deepEqual(finalIngress[2], { service: 'http_status:404' });
});

test('3. GET 500 => throws and fake saw zero PUTs', async () => {
  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 500, body: { error: 'Internal Server Error' }, statusText: 'Internal Server Error' };
      }
      return { status: 200, body: {} };
    },
  });

  const adapter = new CloudflareTunnelIngressAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    tunnelId: TUNNEL_ID,
    token: SECRET_TOKEN,
  });

  await assert.rejects(
    async () => {
      await adapter.addHost('test.example.com', 'http://10.0.0.1:8080');
    },
    (err: Error) => {
      assert.match(err.message, /Failed to GET tunnel configuration: HTTP 500/);
      return true;
    }
  );

  const putCalls = calls.filter(c => c.method === 'PUT');
  assert.equal(putCalls.length, 0);
});

test('4. missing catch-all => throws and fake saw zero PUTs', async () => {
  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return {
          status: 200,
          body: {
            result: {
              config: {
                // Ingress without any catch-all rule (all have hostname)
                ingress: [
                  { hostname: 'alice.example.com', service: 'http://10.0.0.1:8080' },
                ],
              },
            },
          },
        };
      }
      return { status: 200, body: {} };
    },
  });

  const adapter = new CloudflareTunnelIngressAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    tunnelId: TUNNEL_ID,
    token: SECRET_TOKEN,
  });

  await assert.rejects(
    async () => {
      await adapter.addHost('new.example.com', 'http://10.0.0.2:8080');
    },
    (err: Error) => {
      assert.match(err.message, /missing catch-all rule/);
      return true;
    }
  );

  const putCalls = calls.filter(c => c.method === 'PUT');
  assert.equal(putCalls.length, 0);
});

test('5. dryRun makes zero PUTs', async () => {
  const initialIngress = [
    { hostname: 'first.example.com', service: 'http://10.0.0.1:8080' },
    { service: 'http_status:404' },
  ];

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return {
          status: 200,
          body: {
            result: {
              config: {
                ingress: initialIngress,
              },
            },
          },
        };
      }
      return { status: 200, body: {} };
    },
  });

  const adapter = new CloudflareTunnelIngressAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    tunnelId: TUNNEL_ID,
    token: SECRET_TOKEN,
  });

  const result = await adapter.addHost('new.example.com', 'http://10.0.0.2:8080', { dryRun: true });
  assert.equal(result.changed, true);
  assert.ok(result.diff.length > 0);

  const putCalls = calls.filter(c => c.method === 'PUT');
  assert.equal(putCalls.length, 0);
});

test('6. token never in error messages or diffs', async () => {
  const sensitiveToken = 'SUPER_SECRET_TOKEN_DO_NOT_LEAK_XYZ987';

  const { fakeFetch } = createFakeFetch({
    onCall: () => {
      // Simulate network / library failure containing token
      throw new Error(`Unauthorized connection failure with ${sensitiveToken}`);
    },
  });

  const adapter = new CloudflareTunnelIngressAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    tunnelId: TUNNEL_ID,
    token: sensitiveToken,
  });

  try {
    await adapter.addHost('test.example.com', 'http://10.0.0.1:8080');
    assert.fail('Expected exception');
  } catch (err: any) {
    assert.equal(err.message.includes(sensitiveToken), false);
    assert.match(err.message, /\[REDACTED\]/);
  }

  // Also check DNS adapter error sanitization
  const dnsAdapter = new CloudflareDnsAdapter({
    fetch: fakeFetch as any,
    zoneId: ZONE_ID,
    token: sensitiveToken,
  });

  try {
    await dnsAdapter.ensureCname('test.example.com', 'target.cfargotunnel.com');
    assert.fail('Expected exception');
  } catch (err: any) {
    assert.equal(err.message.includes(sensitiveToken), false);
    assert.match(err.message, /\[REDACTED\]/);
  }
});

test('7. DNS ensureCname is idempotent (creates or updates, never duplicates)', async () => {
  const records = [
    { id: 'rec-1', type: 'CNAME', name: 'existing.example.com', content: 'tun1.cfargotunnel.com', proxied: true },
  ];

  const postCalls: any[] = [];
  const putCalls: any[] = [];

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        const url = new URL(call.url);
        const nameFilter = url.searchParams.get('name');
        const matched = nameFilter ? records.filter(r => r.name === nameFilter) : records;
        return {
          status: 200,
          body: {
            result: matched,
            success: true,
          },
        };
      }
      if (call.method === 'POST') {
        postCalls.push(call.body);
        const newRecord = { id: `rec-${records.length + 1}`, ...call.body };
        records.push(newRecord);
        return {
          status: 200,
          body: { result: newRecord, success: true },
        };
      }
      if (call.method === 'PUT') {
        putCalls.push(call.body);
        return {
          status: 200,
          body: { result: call.body, success: true },
        };
      }
      return { status: 404, body: {} };
    },
  });

  const dnsAdapter = new CloudflareDnsAdapter({
    fetch: fakeFetch as any,
    zoneId: ZONE_ID,
    token: SECRET_TOKEN,
  });

  // Case A: ensure existing record with same content does nothing (no PUT, no POST)
  const res1 = await dnsAdapter.ensureCname('existing.example.com', 'tun1.cfargotunnel.com');
  assert.equal(res1.changed, false);
  assert.equal(postCalls.length, 0);
  assert.equal(putCalls.length, 0);

  // Case B: ensure existing record with changed target issues PUT (update, not duplicate POST)
  const res2 = await dnsAdapter.ensureCname('existing.example.com', 'tun2.cfargotunnel.com');
  assert.equal(res2.changed, true);
  assert.equal(postCalls.length, 0);
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].content, 'tun2.cfargotunnel.com');

  // Case C: ensure new record issues POST
  const res3 = await dnsAdapter.ensureCname('brand-new.example.com', 'tun3.cfargotunnel.com');
  assert.equal(res3.changed, true);
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].name, 'brand-new.example.com');
  assert.equal(postCalls[0].content, 'tun3.cfargotunnel.com');
});

test('8. malformed GET (non-JSON, non-2xx, missing ingress) refuses and never PUTs', async () => {
  // Test non-JSON response
  const { fakeFetch: fetchNonJson, calls: calls1 } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: 'Not JSON at all <html>', statusText: 'OK' };
      }
      return { status: 200, body: {} };
    },
  });

  const adapter1 = new CloudflareTunnelIngressAdapter({
    fetch: fetchNonJson as any,
    accountId: ACCOUNT_ID,
    tunnelId: TUNNEL_ID,
    token: SECRET_TOKEN,
  });

  await assert.rejects(
    async () => {
      await adapter1.addHost('test.example.com', 'http://10.0.0.1:8080');
    },
    /Failed to parse tunnel configuration/
  );
  assert.equal(calls1.filter(c => c.method === 'PUT').length, 0);

  // Test missing ingress array
  const { fakeFetch: fetchNoIngress, calls: calls2 } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { result: { config: {} } } };
      }
      return { status: 200, body: {} };
    },
  });

  const adapter2 = new CloudflareTunnelIngressAdapter({
    fetch: fetchNoIngress as any,
    accountId: ACCOUNT_ID,
    tunnelId: TUNNEL_ID,
    token: SECRET_TOKEN,
  });

  await assert.rejects(
    async () => {
      await adapter2.addHost('test.example.com', 'http://10.0.0.1:8080');
    },
    /missing ingress array/
  );
  assert.equal(calls2.filter(c => c.method === 'PUT').length, 0);
});

test('9. removeHost removes specific host and keeps catch-all last', async () => {
  let putSeen = false;
  let finalIngress: any[] = [];

  const initialIngress = [
    { hostname: 'alice.example.com', service: 'http://10.0.0.1:8080' },
    { hostname: 'bob.example.com', service: 'http://10.0.0.2:8080' },
    { service: 'http_status:404' },
  ];

  const { fakeFetch } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return {
          status: 200,
          body: {
            result: {
              config: {
                ingress: initialIngress,
              },
            },
          },
        };
      }
      if (call.method === 'PUT') {
        putSeen = true;
        finalIngress = call.body.config.ingress;
        return { status: 200, body: { success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareTunnelIngressAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    tunnelId: TUNNEL_ID,
    token: SECRET_TOKEN,
  });

  const res = await adapter.removeHost('alice.example.com');
  assert.equal(res.changed, true);
  assert.equal(putSeen, true);

  assert.equal(finalIngress.length, 2);
  assert.deepEqual(finalIngress[0], { hostname: 'bob.example.com', service: 'http://10.0.0.2:8080' });
  assert.deepEqual(finalIngress[1], { service: 'http_status:404' });
});
