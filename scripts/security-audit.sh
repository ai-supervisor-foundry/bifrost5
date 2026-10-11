#!/usr/bin/env bash
set -euo pipefail

# scripts/security-audit.sh [root]
# Exit 1 and print offending paths (never the secret values) if it finds:
# - any docker.sock reference in compose files
# - any .env* file with permissions looser than 600
# - any string that looks like a Cloudflare token or private key in tracked files
# Exit 0 otherwise.

ROOT_DIR="${1:-}"
if [ -z "$ROOT_DIR" ]; then
  ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

if [ ! -d "$ROOT_DIR" ]; then
  echo "Error: Directory '$ROOT_DIR' does not exist." >&2
  exit 1
fi

ROOT_DIR="$(cd "$ROOT_DIR" && pwd -P)"
cd "$ROOT_DIR"

offending_paths=()

# 1. Any docker.sock reference in compose files
# Compose files typically match compose*.yml, compose*.yaml, *docker-compose*.yml, *docker-compose*.yaml
while IFS= read -r -d '' compose_file; do
  [ -f "$compose_file" ] || continue
  # Ignore files under .git
  if [[ "$compose_file" == ./.git/* || "$compose_file" == .git/* ]]; then
    continue
  fi
  if grep -q "docker\.sock" "$compose_file" 2>/dev/null; then
    clean_path="${compose_file#./}"
    offending_paths+=("$clean_path: docker.sock reference in compose file")
  fi
done < <(find . -type f \( -name "*compose*.yml" -o -name "*compose*.yaml" \) -print0)

# 2. Any .env* file with permissions looser than 600
# Looser than 600 means any permission bit in group or other (r, w, x) is set, or user has execute.
# In octal, permissions looser than 600 means (mode & 0177) != 0.
while IFS= read -r -d '' env_file; do
  [ -e "$env_file" ] || continue
  if [[ "$env_file" == ./.git/* || "$env_file" == .git/* ]]; then
    continue
  fi
  # Get numeric octal permissions (e.g. 644)
  # stat -c "%a" on Linux, stat -f "%OLp" on BSD/macOS
  mode="$(stat -c "%a" "$env_file" 2>/dev/null || stat -f "%OLp" "$env_file" 2>/dev/null || true)"
  if [ -n "$mode" ]; then
    # Parse last 3 octal digits
    mode_num=$(( 8#$mode ))
    # Looser than 600: permissions check
    # Check if permissions have any bit from 0177 set: group/others permissions or user execute
    if [ $(( mode_num & 0177 )) -ne 0 ]; then
      clean_path="${env_file#./}"
      offending_paths+=("$clean_path: .env* file permissions looser than 600 (mode: $mode)")
    fi
  fi
done < <(find . -type f -name ".env*" -print0)

# 3. Any string that looks like a Cloudflare token or private key in tracked or untracked (non-ignored) files
# Check tracked and untracked (not ignored) files via git ls-files -co --exclude-standard if inside git repo, otherwise check all files in tree.
tracked_files=()
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r -d '' tf; do
    [ -f "$tf" ] && tracked_files+=("$tf")
  done < <(git ls-files -z -co --exclude-standard)
else
  while IFS= read -r -d '' tf; do
    clean_tf="${tf#./}"
    if [[ "$clean_tf" != .git/* && -f "$clean_tf" ]]; then
      tracked_files+=("$clean_tf")
    fi
  done < <(find . -type f -print0)
fi

# Patterns for secrets:
# - Cloudflare token:
#   * Specific formats like CLOUDFLARE_API_TOKEN=..., CF_API_TOKEN=..., TUNNEL_TOKEN=... with an actual token value assigned (not empty or variable expansion like ${...})
#   * Real Cloudflare 40-character API tokens (alphanumeric/dash/underscore 40 chars)
# - Private key:
#   * -----BEGIN PRIVATE KEY-----
#   * -----BEGIN RSA PRIVATE KEY-----
#   * -----BEGIN EC PRIVATE KEY-----
#   * -----BEGIN OPENSSH PRIVATE KEY-----
#   * -----BEGIN ENCRYPTED PRIVATE KEY-----
#   * -----BEGIN DSA PRIVATE KEY-----
#   * or any "-----BEGIN .*PRIVATE KEY-----"

for tf in "${tracked_files[@]}"; do
  # Skip scanning the security audit script itself or security test script if they contain test patterns
  if [[ "$tf" == "scripts/security-audit.sh" || "$tf" == "tests/scripts/ops.test.sh" ]]; then
    continue
  fi

  has_secret=0

  # Check for private key header
  if grep -E -q -- "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----" "$tf" 2>/dev/null; then
    has_secret=1
  fi

  # Check for Cloudflare token patterns:
  # e.g. TUNNEL_TOKEN: [a-zA-Z0-9_-]{30,} or TUNNEL_TOKEN=[a-zA-Z0-9_-]{30,} or CF_TOKEN / CLOUDFLARE_TOKEN
  # Cloudflare API tokens are 40 chars [a-zA-Z0-9_-]{40}.
  # Also catch assignments like (CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_TOKEN|TUNNEL_TOKEN)[=:][ \t]*["']?[a-zA-Z0-9_-]{20,}["']?
  if [ "$has_secret" -eq 0 ]; then
    if grep -E -i -q "(CLOUDFLARE[A-Z0-9_]*TOKEN|CF[A-Z0-9_]*TOKEN|TUNNEL_TOKEN)[=:][[:space:]]*[\"']?[A-Za-z0-9_-]{20,}[\"']?" "$tf" 2>/dev/null; then
      has_secret=1
    fi
  fi

  if [ "$has_secret" -eq 1 ]; then
    clean_path="${tf#./}"
    offending_paths+=("$clean_path: suspected token or private key in tracked file")
  fi
done

if [ ${#offending_paths[@]} -gt 0 ]; then
  echo "Security audit failed. Offending paths:" >&2
  for op in "${offending_paths[@]}"; do
    echo "  $op" >&2
  done
  exit 1
fi

echo "Security audit passed."
exit 0
