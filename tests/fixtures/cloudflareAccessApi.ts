// Response shapes taken from the Cloudflare OpenAPI spec (access/apps) and a live list call on 2026-10-24
// (ids, emails and audiences replaced). Keep in sync when the API reference changes.

export function envelope<T>(result: T, info?: { page: number; per_page: number; count: number; total_count: number; total_pages: number }) {
  return {
    result,
    success: true,
    errors: [],
    messages: [],
    ...(info ? { result_info: info } : {}),
  };
}

/** A stored policy as the live API returns it: enriched with id/uid/precedence/timestamps and empty exclude/require. */
export function livePolicy(over: Record<string, unknown> = {}) {
  return {
    id: 'pol-id-1',
    uid: 'pol-uid-1',
    name: 'Allow operator email',
    decision: 'allow',
    include: [{ email: { email: 'operator@example.com' } }],
    exclude: [],
    require: [],
    reusable: false,
    precedence: 1,
    created_at: '2026-10-11T17:06:04Z',
    updated_at: '2026-10-11T17:06:04Z',
    ...over,
  };
}

/** A self_hosted app as returned by GET /accounts/{account_id}/access/apps. */
export function liveApp(over: Record<string, unknown> = {}) {
  return {
    id: 'app-id-1',
    uid: 'app-id-1',
    type: 'self_hosted',
    name: 'BYOA MCP',
    aud: 'aud-tag-1',
    domain: 'apps.example.com/p/lander--byoa-mcp',
    self_hosted_domains: ['apps.example.com/p/lander--byoa-mcp'],
    destinations: [{ type: 'public', uri: 'apps.example.com/p/lander--byoa-mcp' }],
    session_duration: '24h',
    app_launcher_visible: true,
    auto_redirect_to_identity: false,
    allowed_idps: [],
    tags: [],
    policies: [livePolicy()],
    created_at: '2026-10-24T00:00:00Z',
    updated_at: '2026-10-24T00:00:00Z',
    ...over,
  };
}
