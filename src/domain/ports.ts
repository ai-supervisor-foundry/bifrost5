import type { RouteSpec } from './routeSpec.ts';

export interface RouteStorePort {
  put(spec: RouteSpec): Promise<void> | void;
  get(id: string): Promise<RouteSpec | null> | RouteSpec | null;
  list(): Promise<RouteSpec[]> | RouteSpec[];
  delete(id: string): Promise<boolean> | boolean;
}

export interface RouteRenderPort {
  write(spec: RouteSpec): Promise<void> | void;
  remove(id: string): Promise<boolean> | boolean;
  listIds(): Promise<string[]> | string[];
}

export interface QuotaStatePort {
  recordRegistration(owner: string, nowMs: number): Promise<void> | void;
  countInWindow(owner: string, windowMs: number, nowMs: number): Promise<number> | number;
}

export interface Clock {
  now(): number;
}
