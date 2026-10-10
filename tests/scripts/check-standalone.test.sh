#!/usr/bin/env bash
set -euo pipefail

# tests/scripts/check-standalone.test.sh
# Tests scripts/check-standalone.sh against pass and fail expectations.
# Acceptance Criteria:
# - clean tree exits 0; tree with forbidden word exits 1
# - the real repository passes the check
# - test script covers pass and fail cases

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$(cd "$SCRIPT_DIR/../../scripts" && pwd)/check-standalone.sh"

if [ ! -x "$CHECK_SCRIPT" ]; then
  echo "Error: $CHECK_SCRIPT is not executable or not found." >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# Test 1: Clean tree must pass (exit 0)
echo "Running Test 1: Clean tree..."
mkdir -p "$TMP_ROOT/clean/src"
echo "console.log('hello world');" > "$TMP_ROOT/clean/src/index.ts"

if ! "$CHECK_SCRIPT" "$TMP_ROOT/clean"; then
  echo "FAIL: Clean tree should have passed" >&2
  exit 1
fi

# Test 2: Tree with forbidden word 'Foundry' (case-insensitive) must fail (exit 1)
echo "Running Test 2: Tree with forbidden word 'Foundry'..."
mkdir -p "$TMP_ROOT/forbidden/src"
echo "const name = 'Foundry';" > "$TMP_ROOT/forbidden/src/app.ts"

if "$CHECK_SCRIPT" "$TMP_ROOT/forbidden" >/dev/null 2>&1; then
  echo "FAIL: Tree with 'Foundry' should have failed" >&2
  exit 1
fi

# Test 3: Tree with allow-listed default must pass (src/domain/routeSpec.ts)
echo "Running Test 3: Tree with allow-listed default (src/domain/routeSpec.ts)..."
mkdir -p "$TMP_ROOT/allowlisted/src/domain"
echo "export const reservedOwner = 'foundry';" > "$TMP_ROOT/allowlisted/src/domain/routeSpec.ts"

if ! "$CHECK_SCRIPT" "$TMP_ROOT/allowlisted"; then
  echo "FAIL: Tree with allow-listed src/domain/routeSpec.ts should have passed" >&2
  exit 1
fi

# Test 4: Tree with allow-listed files under tests/ must pass
echo "Running Test 4: Tree with allow-listed file under tests/..."
mkdir -p "$TMP_ROOT/allowlisted-tests/tests/unit"
echo "describe('foundry tests', () => {});" > "$TMP_ROOT/allowlisted-tests/tests/unit/test.ts"

if ! "$CHECK_SCRIPT" "$TMP_ROOT/allowlisted-tests"; then
  echo "FAIL: Tree with allow-listed tests/ file should have passed" >&2
  exit 1
fi

# Test 5: Tree with allow-listed scripts/e2e-local.sh must pass
echo "Running Test 5: Tree with allow-listed scripts/e2e-local.sh..."
mkdir -p "$TMP_ROOT/allowlisted-e2e/scripts"
echo "#!/bin/bash\n# foundry mock" > "$TMP_ROOT/allowlisted-e2e/scripts/e2e-local.sh"

if ! "$CHECK_SCRIPT" "$TMP_ROOT/allowlisted-e2e"; then
  echo "FAIL: Tree with allow-listed scripts/e2e-local.sh should have passed" >&2
  exit 1
fi

# Test 6: Tree with supervisor import path '../supervisor' must fail
echo "Running Test 6: Tree with '../supervisor' path..."
mkdir -p "$TMP_ROOT/supervisor1/src"
echo "import { foo } from '../supervisor/utils';" > "$TMP_ROOT/supervisor1/src/index.ts"

if "$CHECK_SCRIPT" "$TMP_ROOT/supervisor1" >/dev/null 2>&1; then
  echo "FAIL: Tree with '../supervisor' path should have failed" >&2
  exit 1
fi

# Test 7: Tree with supervisor import path '/supervisor/' must fail
echo "Running Test 7: Tree with '/supervisor/' path..."
mkdir -p "$TMP_ROOT/supervisor2/src"
echo "const mod = require('/supervisor/config');" > "$TMP_ROOT/supervisor2/src/index.ts"

if "$CHECK_SCRIPT" "$TMP_ROOT/supervisor2" >/dev/null 2>&1; then
  echo "FAIL: Tree with '/supervisor/' path should have failed" >&2
  exit 1
fi

# Test 8: Excluded directories (.git, node_modules, docs/plan, BACKUPS) must not fail even if containing 'foundry'
echo "Running Test 8: Excluded directories with forbidden word..."
mkdir -p "$TMP_ROOT/excluded/.git"
mkdir -p "$TMP_ROOT/excluded/node_modules"
mkdir -p "$TMP_ROOT/excluded/docs/plan"
mkdir -p "$TMP_ROOT/excluded/BACKUPS"
echo "foundry" > "$TMP_ROOT/excluded/.git/config"
echo "foundry" > "$TMP_ROOT/excluded/node_modules/pkg.json"
echo "foundry" > "$TMP_ROOT/excluded/docs/plan/doc.md"
echo "foundry" > "$TMP_ROOT/excluded/BACKUPS/old.txt"

if ! "$CHECK_SCRIPT" "$TMP_ROOT/excluded"; then
  echo "FAIL: Excluded directories should not trigger failures" >&2
  exit 1
fi

# Test 9: Runtime directories (logs, .memory, .worktrees) must not fail even if containing 'foundry'
echo "Running Test 9: Runtime directories with forbidden word..."
mkdir -p "$TMP_ROOT/runtime/logs"
mkdir -p "$TMP_ROOT/runtime/.memory"
mkdir -p "$TMP_ROOT/runtime/.worktrees"
echo '{"message": "foundry log entry"}' > "$TMP_ROOT/runtime/logs/x.jsonl"
echo "foundry memory state" > "$TMP_ROOT/runtime/.memory/state.txt"
echo "foundry worktree details" > "$TMP_ROOT/runtime/.worktrees/branch.txt"

if ! "$CHECK_SCRIPT" "$TMP_ROOT/runtime"; then
  echo "FAIL: Runtime directories should not trigger failures" >&2
  exit 1
fi

echo "All tests passed successfully."
exit 0

