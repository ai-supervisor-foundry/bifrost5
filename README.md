# Bifrost5 Edge-kit

Standalone Cloudflare tunnel and Traefik edge kit providing a secure, declarative route registration contract (`edgectl`).

## Purpose

edge-kit manages HTTP ingress via Traefik (using its file provider) behind Cloudflare tunnels. It provides a single CLI contract (`edgectl`) for registering, unregistering, listing, and reconciling routes safely without directly exposing Docker sockets or manual web server configuration.

## Requirements

- Node.js 24+
- Docker
- `flock` (standard on Linux util-linux)

## Environment Variables

- `EDGEKIT_STATE_DIR`: Directory where desired route specifications, lock files, and quota state are stored.
- `EDGEKIT_DYNAMIC_DIR`: Directory where Traefik dynamic YAML route configurations are rendered.
- `EDGEKIT_POLICY`: Path to the policy JSON configuration file defining CIDRs, host allow-lists, and reserved owners.
- `EDGEKIT_ENABLED`: Master switch for mutating operations (`register`, `unregister`, `reconcile`). Defaults to `0`. Must be set to `1` to permit modifications; when unset or `0`, mutations are refused with exit code 3.
- `EDGEKIT_HTTP_PORT`: Port exposed on the host for Traefik HTTP entrypoint (defaults to `18080`).
- `TUNNEL_TOKEN`: Cloudflare tunnel token used by the cloudflared service in `compose.yml`. Must never be printed or logged. Permissions for files containing this secret should be restricted (mode 600).

## Commands

The CLI tool `bin/edgectl` provides the following commands:

- `register`: Registers a new route or updates an existing route with the same spec.
  ```bash
  EDGEKIT_ENABLED=1 bin/edgectl register \
    --owner <owner> \
    --name <name> \
    --host <host> \
    --target <http://ip:port> \
    [--access <private|public>] \
    [--no-strip]
  ```
- `unregister`: Removes a route configuration and its rendered files. Idempotent (exits 0 if already removed).
  ```bash
  EDGEKIT_ENABLED=1 bin/edgectl unregister <id>
  ```
- `list`: Lists all registered routes in JSON format. Works even when `EDGEKIT_ENABLED=0`.
  ```bash
  bin/edgectl list
  ```
- `reconcile`: Reconciles the dynamic directory with the desired state store, cleaning up orphan configuration files.
  ```bash
  EDGEKIT_ENABLED=1 bin/edgectl reconcile
  ```

## Cold start

To get started with edge-kit from scratch:

1. Clone the repository and install dependencies:
   ```bash
   git clone <repo-url> edge-kit
   cd edge-kit
   npm ci
   ```

2. Create the policy configuration file (e.g. `policy.json`):
   ```json
   {
     "reservedOwners": ["ops", "system"],
     "allowedHosts": ["sites.example.com"],
     "ownerCidrs": {
       "alice": ["10.20.0.0/16"]
     }
   }
   ```

3. Configure environment variables:
   ```bash
   export EDGEKIT_STATE_DIR=/var/lib/edgekit/state
   export EDGEKIT_DYNAMIC_DIR=/var/lib/edgekit/dynamic
   export EDGEKIT_POLICY=/var/lib/edgekit/policy.json
   export EDGEKIT_ENABLED=1
   ```

4. Prepare directories and copy `dynamic/security.yml` into the dynamic directory:
   ```bash
   mkdir -p "$EDGEKIT_STATE_DIR" "$EDGEKIT_DYNAMIC_DIR"
   cp dynamic/security.yml "$EDGEKIT_DYNAMIC_DIR/security.yml"
   ```

5. Start edge-kit containers with Docker Compose (tunnel profile and `TUNNEL_TOKEN` are optional):
   ```bash
   docker compose up -d
   # Or with Cloudflare tunnel enabled:
   # TUNNEL_TOKEN="<token>" docker compose --profile tunnel up -d
   ```

6. Register a route and verify it:
   ```bash
   bin/edgectl register \
     --owner alice \
     --name blog \
     --host sites.example.com \
     --target http://10.20.0.5:3000

   bin/edgectl list
   ```

## Policy JSON Example

A policy file controls allowed hostnames, CIDR boundaries per owner, reserved owners, and public access permissions.

`reservedOwners` configured in the policy are merged with built-in defaults (see `DEFAULT_RESERVED_OWNERS` in `src/domain/routeSpec.ts`; they include `apps`, `admin`, `api`, `control`, `connect`), so operators only need to add custom names:

```json
{
  "reservedOwners": ["ops", "system", "internal"],
  "allowedHosts": ["sites.example.com", "test.example.com"],
  "ownerCidrs": {
    "alice": ["10.20.0.0/16"],
    "bob": ["10.30.0.0/16"]
  },
  "denyIps": ["127.0.0.0/8", "169.254.0.0/16", "0.0.0.0/8"],
  "publicOwners": ["bob"]
}
```

## Private Routes and Access Verification

Private routes need an Access JWT verifier service at `http://access-verifier:9000/verify` which this kit does not provide yet. Private routes fail closed until it exists.

## Safety Rules

The kit enforces strict boundaries across all operations:

1. **Owner and Name Format**: Owner must match `^[a-z0-9]+$` (no hyphens). Route ID is `<owner>--<name>` where name matches `^[a-z0-9][a-z0-9-]{0,38}$`. This prevents collision between owners like `alice` and `alice-bob`.
2. **Derived Path Prefix**: `pathPrefix` is automatically derived as `/p/<id>` and cannot be customized by callers.
3. **Reserved Owners**: Configured reserved owners and patterns (merged with built-in defaults) are strictly refused.
4. **Allowed Hostnames**: Hostnames must match the operator allow-list. Host values with backticks or invalid characters are rejected.
5. **IP Target Validation**: Targets must be IPv4 literals matching the owner's permitted CIDR. DNS names, IPv6, loopback (`127.0.0.0/8`), link-local (`169.254.0.0/16`), and `0.0.0.0/8` are refused.
6. **Rate Limiting & Caps**: Per-owner maximum route caps and registration rate limits are enforced at the application layer.
7. **Atomic Writes**: Route files are written to temporary files with non-YAML extensions and atomically renamed.
8. **Concurrency Locking**: All state mutations execute under a local file lock using `flock`.
9. **Mandatory Security Middleware**: The `edgekit-security@file` middleware is always placed first in router definitions and cannot be bypassed.
10. **Idempotent Reconciliation**: `reconcile` safely removes orphan YAML files and re-creates missing definitions without side effects.

## How to Run Tests

- **Unit and cli tests**:
  ```bash
  npm test
  ```
- **Local end-to-end tests**:
  ```bash
  ./scripts/e2e-local.sh
  ```
- **Integration tests (requires docker)**:
  ```bash
  ./tests/integration/traefik.sh
  ```

## Not done yet

- Access JWT verifier service
- tunnel/DNS CLI wiring
- Access app automation

