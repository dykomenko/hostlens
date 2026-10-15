#!/usr/bin/env bash
# Bumps the patch part of "// @version" in the userscript, unless the push
# being processed already changed it. Tampermonkey only offers an update
# when @version grows, so every push has to end up with a higher number.
#
# Usage: bump-version.sh <sha-before-push>
set -euo pipefail

file="hostlens.user.js"
before="${1:-}"

read_version() {
  sed -nE 's#^// @version[[:space:]]+([0-9]+\.[0-9]+\.[0-9]+)[[:space:]]*$#\1#p' | head -n1
}

current="$(read_version < "$file")"
if [ -z "$current" ]; then
  echo "No '// @version x.y.z' line found in $file" >&2
  exit 1
fi

if [ -z "$before" ] || [[ "$before" =~ ^0+$ ]] || ! git cat-file -e "$before:$file" 2>/dev/null; then
  echo "No earlier revision of $file to compare with; leaving version $current as is."
  exit 0
fi

previous="$(git show "$before:$file" | read_version)"
if [ "$previous" != "$current" ]; then
  echo "Version was already changed in this push ($previous -> $current); nothing to do."
  exit 0
fi

IFS=. read -r major minor patch <<< "$current"
next="$major.$minor.$((patch + 1))"
sed -i -E "s#^(// @version[[:space:]]+)${current}#\1${next}#" "$file"
echo "Bumped version $current -> $next"
