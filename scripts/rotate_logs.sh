#!/usr/bin/env bash
set -euo pipefail

# scripts/rotate_logs.sh <dir> [max_bytes=10485760] [keep=5]
# For each *.log in <dir> larger than max_bytes, rotate (copytruncate style:
# copy to name.log.1 shifting older ones up to keep, then truncate the original)
# without losing the newest data and never delete files outside <dir>.

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <dir> [max_bytes] [keep]" >&2
  exit 1
fi

TARGET_DIR="$1"
MAX_BYTES="${2:-10485760}"
KEEP="${3:-5}"

if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: Directory '$TARGET_DIR' does not exist." >&2
  exit 1
fi

# Resolve target directory to absolute path to guarantee safe boundaries
ABS_TARGET_DIR="$(cd "$TARGET_DIR" && pwd -P)"

# Process all *.log files directly in TARGET_DIR
# Using nullglob so if no *.log files exist, loop doesn't run with literal pattern
shopt -s nullglob
for log_file in "$ABS_TARGET_DIR"/*.log; do
  [ -f "$log_file" ] || continue

  # Verify file is strictly inside ABS_TARGET_DIR
  parent_dir="$(dirname "$log_file")"
  if [ "$parent_dir" != "$ABS_TARGET_DIR" ]; then
    continue
  fi

  # Get file size in bytes
  file_size="$(stat -c %s "$log_file" 2>/dev/null || stat -f %z "$log_file")"

  if [ "$file_size" -gt "$MAX_BYTES" ]; then
    base_name="$log_file"

    if [ "$KEEP" -le 0 ]; then
      # If keep is 0, just truncate original
      : > "$base_name"
      continue
    fi

    # Shift older rotated files:
    # Any rotated file index >= KEEP will be removed if shifting into it or exceeding it.
    # We shift downwards from KEEP down to 1.
    for ((i = KEEP; i >= 1; i--)); do
      curr_file="${base_name}.${i}"
      next_idx=$((i + 1))
      next_file="${base_name}.${next_idx}"

      if [ -f "$curr_file" ]; then
        if [ "$next_idx" -gt "$KEEP" ]; then
          # File would exceed keep limit, remove it
          rm -f "$curr_file"
        else
          # Shift to next index
          mv -f "$curr_file" "$next_file"
        fi
      fi
    done

    # Copytruncate: copy original to .1, then truncate original
    cp "$base_name" "${base_name}.1"
    : > "$base_name"
  fi
done
shopt -u nullglob

exit 0
