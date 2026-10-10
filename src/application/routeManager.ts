import type { RouteSpec, Policy } from '../domain/routeSpec.ts';
import { validateRouteSpec, isValidId } from '../domain/routeSpec.ts';
import type { RouteStorePort, RouteRenderPort, QuotaStatePort, Clock } from '../domain/ports.ts';

export interface RouteManagerDeps {
  store: RouteStorePort;
  renderer: RouteRenderPort;
  quota: QuotaStatePort;
  clock: Clock;
  policy: Policy;
}

export interface RouteManagerLimits {
  maxRoutesPerOwner?: number;
  maxRegistrationsPerWindow?: number;
  windowMs?: number;
}

export interface RegisterResult {
  ok: true;
  spec: RouteSpec;
}

function specsEqual(a: RouteSpec, b: RouteSpec): boolean {
  return (
    a.id === b.id &&
    a.owner === b.owner &&
    a.host === b.host &&
    a.pathPrefix === b.pathPrefix &&
    a.target === b.target &&
    a.access === b.access &&
    a.stripPrefix === b.stripPrefix
  );
}

export class RouteManager {
  private deps: RouteManagerDeps;
  private maxRoutesPerOwner: number;
  private maxRegistrationsPerWindow: number;
  private windowMs: number;

  constructor(
    deps: RouteManagerDeps,
    limits?: RouteManagerLimits
  ) {
    this.deps = deps;
    this.maxRoutesPerOwner = limits?.maxRoutesPerOwner ?? 20;
    this.maxRegistrationsPerWindow = limits?.maxRegistrationsPerWindow ?? 10;
    this.windowMs = limits?.windowMs ?? 60000;
  }

  async register(input: unknown): Promise<RegisterResult> {
    // 1. Validation (pure, no I/O before validation passes)
    const validationResult = validateRouteSpec(input, this.deps.policy);
    if (!validationResult.ok) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }
    const spec = validationResult.spec;

    // 2. Check existing spec in store
    const existing = await this.deps.store.get(spec.id);
    if (existing && specsEqual(existing, spec)) {
      // Idempotent: same result, does NOT consume rate-limit quota, does not duplicate write
      return { ok: true, spec: existing };
    }

    const nowMs = this.deps.clock.now();

    // 3. Per-owner route cap: if this is a new route id, check cap
    if (!existing) {
      const allRoutes = await this.deps.store.list();
      const ownerCount = allRoutes.filter(r => r.owner === spec.owner).length;
      if (ownerCount >= this.maxRoutesPerOwner) {
        throw new Error(
          `Max routes per owner exceeded for owner '${spec.owner}' (current: ${ownerCount}, max: ${this.maxRoutesPerOwner})`
        );
      }
    }

    // 4. Rate limit check
    const currentWindowRegistrations = await this.deps.quota.countInWindow(
      spec.owner,
      this.windowMs,
      nowMs
    );
    if (currentWindowRegistrations >= this.maxRegistrationsPerWindow) {
      throw new Error(
        `Registration rate limit exceeded for owner '${spec.owner}' in window (current: ${currentWindowRegistrations}, max: ${this.maxRegistrationsPerWindow})`
      );
    }

    // 5. Consume rate-limit quota
    await this.deps.quota.recordRegistration(spec.owner, nowMs);

    // 6. On success: store.put then renderer.write
    await this.deps.store.put(spec);
    await this.deps.renderer.write(spec);

    return { ok: true, spec };
  }

  async unregister(id: string): Promise<boolean> {
    if (!isValidId(id)) {
      throw new Error(`Validation failed: invalid id '${id}'`);
    }
    await this.deps.store.delete(id);
    await this.deps.renderer.remove(id);
    return true;
  }

  async list(): Promise<RouteSpec[]> {
    const routes = await this.deps.store.list();
    return routes;
  }

  async reconcile(): Promise<{ written: string[]; removed: string[]; skipped?: { id: string; errors: string[] }[] }> {
    const storeRoutes = await this.deps.store.list();
    const validStoreRouteMap = new Map<string, RouteSpec>();
    const skipped: { id: string; errors: string[] }[] = [];

    for (const r of storeRoutes) {
      const valResult = validateRouteSpec(r, this.deps.policy);
      if (valResult.ok) {
        validStoreRouteMap.set(r.id, valResult.spec);
      } else {
        skipped.push({ id: r.id, errors: valResult.errors });
      }
    }

    const rendererIds = await this.deps.renderer.listIds();
    const rendererIdSet = new Set(rendererIds);

    const written: string[] = [];
    const removed: string[] = [];

    // 1. Remove orphans: renderer ids not in the valid store routes
    for (const rid of rendererIds) {
      if (!validStoreRouteMap.has(rid)) {
        await this.deps.renderer.remove(rid);
        removed.push(rid);
      }
    }

    // 2. Rewrite missing / ensure renderer matches store
    for (const [id, spec] of validStoreRouteMap) {
      if (!rendererIdSet.has(id)) {
        await this.deps.renderer.write(spec);
        written.push(id);
      }
    }

    const result: { written: string[]; removed: string[]; skipped?: { id: string; errors: string[] }[] } = {
      written,
      removed,
    };
    if (skipped.length > 0) {
      result.skipped = skipped;
    }

    return result;
  }
}
