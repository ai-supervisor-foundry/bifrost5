#!/usr/bin/env bash
set -euo pipefail

# scripts/check-standalone.sh
# Scans the repository tree (or provided root dir) for forbidden words or supervisor imports.
# Acceptance Criteria:
# - clean tree exits 0; tree with forbidden word exits 1
# - the real repository passes the check
# - test script covers pass and fail cases

ROOT_DIR="${1:-}"
if [ -z "$ROOT_DIR" ]; then
  ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

cd "$ROOT_DIR"

# Allow-listed files for the word 'foundry' (case-insensitive):
# - src/domain/routeSpec.ts (reserved-owner default)
# - anything under tests/
# - scripts/e2e-local.sh
is_foundry_allowed() {
  local rel_path="$1"
  rel_path="${rel_path#./}"

  if [[ "$rel_path" == "src/domain/routeSpec.ts" ]]; then
    return 0
  fi
  if [[ "$rel_path" == tests/* ]]; then
    return 0
  fi
  if [[ "$rel_path" == "scripts/e2e-local.sh" ]]; then
    return 0
  fi

  return 1
}

# Excluded from scanning:
# .git, node_modules, docs/plan, BACKUPS, and the script itself and its test
is_excluded() {
  local rel_path="$1"
  rel_path="${rel_path#./}"

  if [[ "$rel_path" == .git || "$rel_path" == .git/* ]]; then
    return 0
  fi
  if [[ "$rel_path" == node_modules || "$rel_path" == node_modules/* ]]; then
    return 0
  fi
  if [[ "$rel_path" == docs/plan || "$rel_path" == docs/plan/* ]]; then
    return 0
  fi
  if [[ "$rel_path" == BACKUPS || "$rel_path" == BACKUPS/* ]]; then
    return 0
  fi
  if [[ "$rel_path" == "scripts/check-standalone.sh" ]]; then
    return 0
  fi
  if [[ "$rel_path" == "tests/scripts/check-standalone.test.sh" ]]; then
    return 0
  fi

  return 1
}

foundry_violations=()
supervisor_violations=()

# Find all regular files in ROOT_DIR
while IFS= read -r -d '' file; do
  rel_file="${file#./}"

  if is_excluded "$rel_file"; then
    continue
  fi

  # fail if any file imports a path containing '../supervisor' or '/supervisor/'
  if grep -E "(\.\./supervisor|/supervisor/)" "$rel_file" >/dev/null 2>&1; then
    supervisor_violations+=("$rel_file: references supervisor import path")
  fi

  # fail if any file contains the word 'foundry' (case-insensitive) outside allow-list
  if ! is_foundry_allowed "$rel_file"; then
    if grep -iq "foundry" "$rel_file" 2>/dev/null; then
      foundry_violations+=("$rel_file: contains forbidden word 'foundry'")
    fi
  fi
done < <(find . -type f -print0)

has_error=0

if [ ${#foundry_violations[@]} -gt 0 ]; then
  echo "Foundry violations found:" >&2
  for v in "${foundry_violations[@]}"; do
    echo "  - $v" >&2
  done
  has_error=1
fi

if [ ${#supervisor_violations[@]} -gt 0 ]; then
  echo "Supervisor violations found:" >&2
  for v in "${supervisor_violations[@]}"; do
    echo "  - $v" >&2
  done
  has_error=1
fi

if [ "$has_error" -ne 0 ]; then
  exit 1
fi

echo "Standalone check passed."
exit 0
