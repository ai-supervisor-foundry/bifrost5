export type RouteSpec = {
  id: string;
  owner: string;
  host: string;
  pathPrefix: string;
  target: string;
  access: 'private' | 'public';
  stripPrefix: boolean;
};

export type Policy = {
  reservedOwners?: string[];
  allowedHosts: string[];
  ownerCidrs: Record<string, string[]>;
  denyIps?: string[];
  publicOwners?: string[];
};

export function deriveId(owner: string, name: string): string {
  return `${owner}--${name}`;
}

const DEFAULT_RESERVED_OWNERS = ['foundry*', 'apps', 'admin', 'api', 'control', 'connect'];
const DEFAULT_DENY_IPS = ['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8'];

const OWNER_REGEX = /^[a-z0-9]+$/;
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,38}$/;
const HOST_REGEX = /^[a-z0-9.-]+$/;

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }
  return value === pattern;
}

function parseIpv4(ipStr: string): number | null {
  const parts = ipStr.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let num = 0;
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d+$/.test(part)) {
      return null;
    }
    if (part.length > 1 && part.startsWith('0')) {
      return null;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return null;
    }
    num = (num << 8) | n;
  }
  return num >>> 0;
}

function parseCidr(cidr: string): { network: number; mask: number } | null {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) {
    const ip = parseIpv4(cidr);
    if (ip === null) return null;
    return { network: ip, mask: 0xffffffff };
  }
  const ipPart = cidr.slice(0, slashIdx);
  const prefixPart = cidr.slice(slashIdx + 1);
  if (!/^\d+$/.test(prefixPart)) {
    return null;
  }
  const prefixLen = Number(prefixPart);
  if (prefixLen < 0 || prefixLen > 32) {
    return null;
  }
  const ip = parseIpv4(ipPart);
  if (ip === null) {
    return null;
  }
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return { network: (ip & mask) >>> 0, mask };
}

function ipMatchesCidr(ipNum: number, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  return (ipNum & parsed.mask) >>> 0 === parsed.network;
}

export function validateRouteSpec(
  input: unknown,
  policy: Policy
): { ok: true; spec: RouteSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['Input must be a non-null object'] };
  }

  const raw = input as Record<string, unknown>;

  // Check required raw fields
  if (typeof raw.owner !== 'string') {
    errors.push('owner is required and must be a string');
  }
  if (typeof raw.id !== 'string') {
    errors.push('id is required and must be a string');
  }
  if (typeof raw.host !== 'string') {
    errors.push('host is required and must be a string');
  }
  if (typeof raw.target !== 'string') {
    errors.push('target is required and must be a string');
  }

  const reservedOwners = policy.reservedOwners ?? DEFAULT_RESERVED_OWNERS;
  const denyIps = policy.denyIps ?? DEFAULT_DENY_IPS;
  const publicOwners = policy.publicOwners ?? [];

  const owner = typeof raw.owner === 'string' ? raw.owner : '';
  const id = typeof raw.id === 'string' ? raw.id : '';
  const host = typeof raw.host === 'string' ? raw.host : '';
  const target = typeof raw.target === 'string' ? raw.target : '';

  // Rule 1: owner matches ^[a-z0-9]+$ (no '-')
  let ownerValid = false;
  if (typeof raw.owner === 'string') {
    if (!OWNER_REGEX.test(owner)) {
      errors.push('owner must match ^[a-z0-9]+$');
    } else {
      ownerValid = true;
    }
  }

  // Name checking and id = `${owner}--${name}`
  let derivedExpectedId: string | null = null;
  if (typeof raw.id === 'string') {
    if (ownerValid) {
      const prefix = `${owner}--`;
      if (!id.startsWith(prefix)) {
        errors.push(`id must equal \${owner}--\${name}`);
      } else {
        const name = id.slice(prefix.length);
        if (!NAME_REGEX.test(name)) {
          errors.push('name must match ^[a-z0-9][a-z0-9-]{0,38}$');
        } else {
          derivedExpectedId = deriveId(owner, name);
        }
      }
    } else {
      // Owner is invalid or missing
      if (typeof raw.owner === 'string') {
        const doubleDashIdx = id.indexOf('--');
        if (doubleDashIdx > 0) {
          const namePart = id.slice(doubleDashIdx + 2);
          if (!NAME_REGEX.test(namePart)) {
            errors.push('name must match ^[a-z0-9][a-z0-9-]{0,38}$');
          }
        }
      }
    }
  }

  // Rule 3: owner or id matching a reserved pattern is rejected
  if (typeof raw.owner === 'string') {
    for (const pat of reservedOwners) {
      if (matchesPattern(owner, pat)) {
        errors.push(`owner matches reserved pattern '${pat}'`);
        break;
      }
    }
  }

  if (typeof raw.id === 'string') {
    for (const pat of reservedOwners) {
      if (matchesPattern(id, pat)) {
        errors.push(`id matches reserved pattern '${pat}'`);
        break;
      }
    }
  }

  // Rule 2: pathPrefix is DERIVED as /p/<id>/ ; a caller-supplied pathPrefix that differs is an error
  const expectedPathPrefix = typeof raw.id === 'string' ? `/p/${id}/` : '';
  if ('pathPrefix' in raw && raw.pathPrefix !== undefined) {
    if (typeof raw.pathPrefix !== 'string' || raw.pathPrefix !== expectedPathPrefix) {
      errors.push(`pathPrefix must be '${expectedPathPrefix}'`);
    }
  }

  // Rule 4: host must exactly match an entry in policy.allowedHosts AND match ^[a-z0-9.-]+$
  if (typeof raw.host === 'string') {
    if (!HOST_REGEX.test(host)) {
      errors.push('host must match ^[a-z0-9.-]+$');
    }
    if (!policy.allowedHosts.includes(host)) {
      errors.push(`host '${host}' is not in policy.allowedHosts`);
    }
  }

  // Rule 5: target must be an http://<IPv4 literal>:<port> URL
  let parsedTargetIp: number | null = null;
  if (typeof raw.target === 'string') {
    const targetMatch = target.match(/^http:\/\/([^:/]+):(\d+)$/);
    if (!targetMatch) {
      errors.push('target must be an http://<IPv4 literal>:<port> URL');
    } else {
      const hostPart = targetMatch[1];
      const portPart = Number(targetMatch[2]);
      if (portPart < 1 || portPart > 65535) {
        errors.push('target port must be between 1 and 65535');
      }
      const ip = parseIpv4(hostPart);
      if (ip === null) {
        errors.push('target host must be a valid IPv4 literal');
      } else {
        parsedTargetIp = ip;
        // Check denyIps
        for (const denyCidr of denyIps) {
          if (ipMatchesCidr(ip, denyCidr)) {
            errors.push(`target IP is in denied range '${denyCidr}'`);
            break;
          }
        }

        // Check owner CIDRs
        if (ownerValid) {
          const allowedCidrs = policy.ownerCidrs[owner];
          if (!allowedCidrs || allowedCidrs.length === 0) {
            errors.push(`no allowed CIDRs defined for owner '${owner}'`);
          } else {
            const inAllowedCidr = allowedCidrs.some(cidr => ipMatchesCidr(ip, cidr));
            if (!inAllowedCidr) {
              errors.push(`target IP is outside allowed CIDRs for owner '${owner}'`);
            }
          }
        }
      }
    }
  }

  // Access check
  let access: 'private' | 'public' = 'private';
  if ('access' in raw && raw.access !== undefined) {
    if (raw.access !== 'private' && raw.access !== 'public') {
      errors.push("access must be 'private' or 'public'");
    } else {
      access = raw.access;
      if (access === 'public' && ownerValid && !publicOwners.includes(owner)) {
        errors.push(`owner '${owner}' is not allowed to register public routes`);
      }
    }
  }

  // stripPrefix
  let stripPrefix = true;
  if ('stripPrefix' in raw && raw.stripPrefix !== undefined) {
    if (typeof raw.stripPrefix !== 'boolean') {
      errors.push('stripPrefix must be a boolean');
    } else {
      stripPrefix = raw.stripPrefix;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const spec: RouteSpec = {
    id,
    owner,
    host,
    pathPrefix: expectedPathPrefix,
    target,
    access,
    stripPrefix,
  };

  return { ok: true, spec };
}
