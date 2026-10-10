#!/usr/bin/env bash
set -euo pipefail

# tests/scripts/ops.test.sh
# Acceptance Criteria:
# - rotation keeps at most N rotated files and never touches files outside the directory
# - newest content is in .log.1
# - audit passes on a clean tree and fails (without printing the secret) on a tree with
#   a docker.sock mount, a world-readable .env, and a fake -----BEGIN PRIVATE KEY----- file
# - audit never prints secret values

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROTATE_SCRIPT="$REPO_ROOT/scripts/rotate_logs.sh"
AUDIT_SCRIPT="$REPO_ROOT/scripts/security-audit.sh"

if [ ! -x "$ROTATE_SCRIPT" ]; then
  echo "Error: $ROTATE_SCRIPT is not executable or not found." >&2
  exit 1
fi

if [ ! -x "$AUDIT_SCRIPT" ]; then
  echo "Error: $AUDIT_SCRIPT is not executable or not found." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "=== Testing rotate_logs.sh ==="

# Test 1: Basic rotation and newest content in .log.1
echo "Test 1: Rotation rotates and puts newest content in .log.1..."
LOG_DIR="$TMP_DIR/logs1"
mkdir -p "$LOG_DIR"

# Create a small log file (100 bytes)
head -c 100 </dev/zero | tr '\0' 'A' > "$LOG_DIR/app.log"

# Run rotate_logs with threshold 50 bytes and keep 3
"$ROTATE_SCRIPT" "$LOG_DIR" 50 3

# Check that app.log was truncated to 0 and app.log.1 exists with 100 bytes
if [ ! -f "$LOG_DIR/app.log.1" ]; then
  echo "FAIL: app.log.1 was not created" >&2
  exit 1
fi
if [ -s "$LOG_DIR/app.log" ]; then
  echo "FAIL: app.log was not truncated" >&2
  exit 1
fi
size1=$(stat -c %s "$LOG_DIR/app.log.1" 2>/dev/null || stat -f %z "$LOG_DIR/app.log.1")
if [ "$size1" -ne 100 ]; then
  echo "FAIL: app.log.1 has unexpected size $size1" >&2
  exit 1
fi

# Append new content "NEW_CONTENT" to app.log and rotate again
echo "NEW_CONTENT" > "$LOG_DIR/app.log"
# Pad to exceed 50 bytes
head -c 100 </dev/zero | tr '\0' 'B' >> "$LOG_DIR/app.log"

"$ROTATE_SCRIPT" "$LOG_DIR" 50 3

# Check that newest content is in .log.1 and older content is shifted to .log.2
if ! grep -q "NEW_CONTENT" "$LOG_DIR/app.log.1"; then
  echo "FAIL: newest content is not in .log.1" >&2
  exit 1
fi
if [ ! -f "$LOG_DIR/app.log.2" ]; then
  echo "FAIL: app.log.2 was not created" >&2
  exit 1
fi
size2=$(stat -c %s "$LOG_DIR/app.log.2" 2>/dev/null || stat -f %z "$LOG_DIR/app.log.2")
if [ "$size2" -ne 100 ]; then
  echo "FAIL: app.log.2 has unexpected size $size2" >&2
  exit 1
fi

# Test 2: Rotation keeps at most `keep` files
echo "Test 2: Rotation keeps at most keep files..."
# Rotate multiple times with keep=3
for i in {1..5}; do
  echo "LOG_CYCLE_$i" > "$LOG_DIR/app.log"
  head -c 100 </dev/zero | tr '\0' 'C' >> "$LOG_DIR/app.log"
  "$ROTATE_SCRIPT" "$LOG_DIR" 50 3
done

# We should have app.log, app.log.1, app.log.2, app.log.3
# We should NOT have app.log.4 or app.log.5
if [ -f "$LOG_DIR/app.log.4" ] || [ -f "$LOG_DIR/app.log.5" ]; then
  echo "FAIL: files beyond keep=3 exist!" >&2
  ls -la "$LOG_DIR" >&2
  exit 1
fi

count=$(ls "$LOG_DIR"/app.log.* 2>/dev/null | wc -l)
if [ "$count" -gt 3 ]; then
  echo "FAIL: expected at most 3 rotated files, found $count" >&2
  exit 1
fi

# Test 3: Rotation never touches files outside <dir>
echo "Test 3: Never touches files outside <dir>..."
PARENT_FILE="$TMP_DIR/important_parent.log"
echo "parent content" > "$PARENT_FILE"

"$ROTATE_SCRIPT" "$LOG_DIR" 50 3

if [ ! -f "$PARENT_FILE" ]; then
  echo "FAIL: file outside directory was deleted!" >&2
  exit 1
fi
if [ "$(cat "$PARENT_FILE")" != "parent content" ]; then
  echo "FAIL: file outside directory was modified!" >&2
  exit 1
fi

# Test 4: Files smaller than max_bytes are not rotated
echo "Test 4: Files <= max_bytes are untouched..."
SMALL_LOG="$LOG_DIR/small.log"
echo "small" > "$SMALL_LOG"
"$ROTATE_SCRIPT" "$LOG_DIR" 1000 3
if [ -f "$LOG_DIR/small.log.1" ]; then
  echo "FAIL: small.log should not have been rotated" >&2
  exit 1
fi
if [ "$(cat "$SMALL_LOG")" != "small" ]; then
  echo "FAIL: small.log content changed" >&2
  exit 1
fi

echo "=== Testing security-audit.sh ==="

# Test 5: Audit passes on clean tree
echo "Test 5: Audit passes on clean tree..."
CLEAN_DIR="$TMP_DIR/clean_tree"
mkdir -p "$CLEAN_DIR"
cat << 'EOF' > "$CLEAN_DIR/compose.yml"
services:
  web:
    image: nginx
EOF
touch "$CLEAN_DIR/.env"
chmod 600 "$CLEAN_DIR/.env"
echo "hello world" > "$CLEAN_DIR/README.md"

if ! "$AUDIT_SCRIPT" "$CLEAN_DIR"; then
  echo "FAIL: audit should have passed on clean tree" >&2
  exit 1
fi

# Test 6: Audit fails on tree with docker.sock mount
echo "Test 6: Audit fails on docker.sock mount..."
SOCK_DIR="$TMP_DIR/sock_tree"
mkdir -p "$SOCK_DIR"
cat << 'EOF' > "$SOCK_DIR/compose.yml"
services:
  app:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
EOF

output_sock="$("$AUDIT_SCRIPT" "$SOCK_DIR" 2>&1 || true)"
if "$AUDIT_SCRIPT" "$SOCK_DIR" >/dev/null 2>&1; then
  echo "FAIL: audit should have failed on docker.sock tree" >&2
  exit 1
fi
if ! echo "$output_sock" | grep -q "compose.yml"; then
  echo "FAIL: audit output should mention offending path compose.yml" >&2
  exit 1
fi

# Test 7: Audit fails on tree with world-readable / loose .env
echo "Test 7: Audit fails on loose .env..."
ENV_DIR="$TMP_DIR/env_tree"
mkdir -p "$ENV_DIR"
touch "$ENV_DIR/.env.production"
chmod 644 "$ENV_DIR/.env.production"

output_env="$("$AUDIT_SCRIPT" "$ENV_DIR" 2>&1 || true)"
if "$AUDIT_SCRIPT" "$ENV_DIR" >/dev/null 2>&1; then
  echo "FAIL: audit should have failed on loose .env file" >&2
  exit 1
fi
if ! echo "$output_env" | grep -q "\.env\.production"; then
  echo "FAIL: audit output should mention offending path .env.production" >&2
  exit 1
fi

# Test 8: Audit fails on tree with fake private key and NEVER prints secret values
echo "Test 8: Audit fails on fake private key and NEVER prints secret values..."
KEY_DIR="$TMP_DIR/key_tree"
mkdir -p "$KEY_DIR"
SECRET_VALUE="MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCfakeSecretString123456"
cat << EOF > "$KEY_DIR/server.key"
-----BEGIN PRIVATE KEY-----
$SECRET_VALUE
-----END PRIVATE KEY-----
EOF

output_key="$("$AUDIT_SCRIPT" "$KEY_DIR" 2>&1 || true)"
if "$AUDIT_SCRIPT" "$KEY_DIR" >/dev/null 2>&1; then
  echo "FAIL: audit should have failed on private key tree" >&2
  exit 1
fi
if ! echo "$output_key" | grep -q "server.key"; then
  echo "FAIL: audit output should mention offending path server.key" >&2
  exit 1
fi
if echo "$output_key" | grep -q "$SECRET_VALUE"; then
  echo "FAIL: audit leaked secret value in stdout/stderr!" >&2
  exit 1
fi
if echo "$output_key" | grep -q "BEGIN PRIVATE KEY"; then
  echo "FAIL: audit printed secret key header in stdout/stderr!" >&2
  exit 1
fi

# Test 9: Audit fails on tree with fake Cloudflare token and NEVER prints secret
echo "Test 9: Audit fails on fake Cloudflare token without printing token..."
CF_DIR="$TMP_DIR/cf_tree"
mkdir -p "$CF_DIR"
CF_SECRET="vL40xYzABCD1234_FAKE_CLOUDFLARE_TOKEN_999"
echo "CLOUDFLARE_API_TOKEN=\"$CF_SECRET\"" > "$CF_DIR/config.txt"

output_cf="$("$AUDIT_SCRIPT" "$CF_DIR" 2>&1 || true)"
if "$AUDIT_SCRIPT" "$CF_DIR" >/dev/null 2>&1; then
  echo "FAIL: audit should have failed on Cloudflare token" >&2
  exit 1
fi
if ! echo "$output_cf" | grep -q "config.txt"; then
  echo "FAIL: audit output should mention offending path config.txt" >&2
  exit 1
fi
if echo "$output_cf" | grep -q "$CF_SECRET"; then
  echo "FAIL: audit leaked Cloudflare secret token in stdout/stderr!" >&2
  exit 1
fi

# Test 10: Real repository passes the audit
echo "Test 10: Current repository passes audit..."
if ! "$AUDIT_SCRIPT" "$REPO_ROOT"; then
  echo "FAIL: Real repository failed security audit!" >&2
  exit 1
fi

echo "All ops tests passed successfully."
exit 0
