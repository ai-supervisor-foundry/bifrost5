import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CloudflareAccessAdapter,
  ACCESS_APPS_PATH_TEMPLATE,
} from '../../src/adapters/cloudflareAccess.ts';
import type { AccessPolicy } from '../../src/domain/ports.ts';

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

const SECRET_TOKEN = 'secret-cf-token-access-12345';
const ACCOUNT_ID = 'acc-999';

const ALLOW_POLICY: AccessPolicy = {
  decision: 'allow',
  include: [{ email_domain: { domain: 'example.com' } }],
};

test('1. ensure creates a new app when none exists, dryRun performs no mutating request', async () => {
  const apps: any[] = [];

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { result: apps, success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareAccessAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  const dry = await adapter.ensure('new.example.com', 'new-app', ALLOW_POLICY, { dryRun: true });
  assert.equal(dry.changed, true);
  assert.ok(dry.diff && dry.diff.length > 0);
  assert.equal(apps.length, 0);

  const mutating = calls.filter((c) => c.method !== 'GET');
  assert.equal(mutating.length, 0);
});

test('2. ensure creates for real when not dryRun, and is idempotent on repeat', async () => {
  const apps: any[] = [];
  let nextId = 1;

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { result: apps, success: true } };
      }
      if (call.method === 'POST') {
        const created = { id: `app-${nextId++}`, ...call.body };
        apps.push(created);
        return { status: 200, body: { result: created, success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareAccessAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  const first = await adapter.ensure('idem.example.com', 'idem-app', ALLOW_POLICY, { dryRun: false });
  assert.equal(first.changed, true);
  assert.ok(first.appId);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);

  // Repeat with identical inputs: must be idempotent, no second mutating call
  const second = await adapter.ensure('idem.example.com', 'idem-app', ALLOW_POLICY, { dryRun: false });
  assert.equal(second.changed, false);
  assert.equal(second.appId, first.appId);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('3. ensure updates an existing app whose policy changed, dryRun makes no PUT', async () => {
  const existingApp = {
    id: 'app-existing',
    name: 'old-name',
    domain: 'update.example.com',
    policies: [ALLOW_POLICY],
  };
  const apps: any[] = [existingApp];

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { result: apps, success: true } };
      }
      if (call.method === 'PUT') {
        return { status: 200, body: { success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareAccessAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  const newPolicy: AccessPolicy = {
    decision: 'allow',
    include: [{ email: { email: 'carol@example.com' } }],
  };

  const dry = await adapter.ensure('update.example.com', 'new-name', newPolicy, { dryRun: true });
  assert.equal(dry.changed, true);
  assert.equal(dry.appId, 'app-existing');
  assert.ok(dry.diff && dry.diff.length > 0);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);

  const live = await adapter.ensure('update.example.com', 'new-name', newPolicy, { dryRun: false });
  assert.equal(live.changed, true);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
});

test('4. ensure is a no-op when name and policy already match (no mutating request)', async () => {
  const existingApp = {
    id: 'app-same',
    name: 'same-app',
    domain: 'same.example.com',
    policies: [ALLOW_POLICY],
  };
  const apps: any[] = [existingApp];

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { result: apps, success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareAccessAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  const res = await adapter.ensure('same.example.com', 'same-app', ALLOW_POLICY, { dryRun: false });
  assert.equal(res.changed, false);
  assert.equal(res.appId, 'app-same');
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});

test('5. list returns all apps from the mocked API', async () => {
  const apps: any[] = [
    { id: 'app-1', name: 'one', domain: 'one.example.com', policies: [ALLOW_POLICY] },
    { id: 'app-2', name: 'two', domain: 'two.example.com' },
  ];

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { result: apps, success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareAccessAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  const result = await adapter.list();
  assert.equal(result.length, 2);
  assert.equal(result[0].domain, 'one.example.com');
  assert.equal(result[1].domain, 'two.example.com');
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});

test('6. remove deletes only the app whose domain matches exactly, dryRun makes no DELETE', async () => {
  const apps: any[] = [
    { id: 'app-exact', name: 'exact', domain: 'remove.example.com', policies: [ALLOW_POLICY] },
    { id: 'app-sub', name: 'sub', domain: 'sub.remove.example.com', policies: [ALLOW_POLICY] },
    { id: 'app-other', name: 'other', domain: 'other-remove.example.com', policies: [ALLOW_POLICY] },
  ];

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { result: apps, success: true } };
      }
      if (call.method === 'DELETE') {
        return { status: 200, body: { success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareAccessAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  const dry = await adapter.remove('remove.example.com', { dryRun: true });
  assert.equal(dry.changed, true);
  assert.ok(dry.diff && dry.diff.length > 0);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);

  const live = await adapter.remove('remove.example.com', { dryRun: false });
  assert.equal(live.changed, true);
  const deleteCalls = calls.filter((c) => c.method === 'DELETE');
  assert.equal(deleteCalls.length, 1);
  assert.ok(deleteCalls[0].url.endsWith('/app-exact'));

  // Lookalike domains (substring / superstring matches) must never be targeted
  assert.equal(deleteCalls[0].url.includes('app-sub'), false);
  assert.equal(deleteCalls[0].url.includes('app-other'), false);
});

test('7. remove is idempotent when the app is already gone', async () => {
  const apps: any[] = [];

  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { result: apps, success: true } };
      }
      return { status: 404, body: {} };
    },
  });

  const adapter = new CloudflareAccessAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  const res = await adapter.remove('missing.example.com', { dryRun: false });
  assert.equal(res.changed, false);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('8. GET failure throws and never mutates', async () => {
  const { fakeFetch, calls } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 500, body: { error: 'Internal Server Error' }, statusText: 'Internal Server Error' };
      }
      return { status: 200, body: {} };
    },
  });

  const adapter = new CloudflareAccessAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  await assert.rejects(
    async () => {
      await adapter.ensure('fail.example.com', 'fail-app', ALLOW_POLICY, { dryRun: false });
    },
    (err: Error) => {
      assert.match(err.message, /Failed to list Access apps: HTTP 500/);
      return true;
    }
  );

  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});

test('9. malformed GET response (non-JSON, missing result array) refuses and never mutates', async () => {
  const { fakeFetch: fetchNonJson, calls: calls1 } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: 'Not JSON at all <html>' };
      }
      return { status: 200, body: {} };
    },
  });

  const adapter1 = new CloudflareAccessAdapter({
    fetch: fetchNonJson as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  await assert.rejects(
    async () => {
      await adapter1.list();
    },
    /Failed to parse Access apps list response/
  );
  assert.equal(calls1.filter((c) => c.method !== 'GET').length, 0);

  const { fakeFetch: fetchNoResult, calls: calls2 } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { success: true } };
      }
      return { status: 200, body: {} };
    },
  });

  const adapter2 = new CloudflareAccessAdapter({
    fetch: fetchNoResult as any,
    accountId: ACCOUNT_ID,
    token: SECRET_TOKEN,
  });

  await assert.rejects(
    async () => {
      await adapter2.list();
    },
    /missing result array/
  );
  assert.equal(calls2.filter((c) => c.method !== 'GET').length, 0);
});

test('10. token never appears in error messages or diffs', async () => {
  const sensitiveToken = 'ACCESS_SECRET_DO_NOT_LEAK_987XYZ';

  const { fakeFetch } = createFakeFetch({
    onCall: () => {
      throw new Error(`Unauthorized connection failure with ${sensitiveToken}`);
    },
  });

  const adapter = new CloudflareAccessAdapter({
    fetch: fakeFetch as any,
    accountId: ACCOUNT_ID,
    token: sensitiveToken,
  });

  try {
    await adapter.list();
    assert.fail('Expected exception');
  } catch (err: any) {
    assert.equal(err.message.includes(sensitiveToken), false);
    assert.match(err.message, /\[REDACTED\]/);
  }

  const apps: any[] = [];
  const { fakeFetch: okFetch } = createFakeFetch({
    onCall: (call) => {
      if (call.method === 'GET') {
        return { status: 200, body: { result: apps, success: true } };
      }
      return { status: 200, body: { success: true } };
    },
  });

  const adapter2 = new CloudflareAccessAdapter({
    fetch: okFetch as any,
    accountId: ACCOUNT_ID,
    token: sensitiveToken,
  });

  const dry = await adapter2.ensure('leak.example.com', 'leak-app', ALLOW_POLICY, { dryRun: true });
  assert.ok(dry.diff && dry.diff.length > 0);
  assert.equal(dry.diff!.includes(sensitiveToken), false);
});

test('11. ACCESS_APPS_PATH_TEMPLATE is exported and parameterized by account_id', () => {
  assert.match(ACCESS_APPS_PATH_TEMPLATE, /\{account_id\}/);
});
