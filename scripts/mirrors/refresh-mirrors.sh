#!/usr/bin/env bash
# Refresh the read-only repository mirrors the coding agents mount.
#
#   refresh-mirrors.sh [<name>...]        refresh every mirror, or the named ones
#   refresh-mirrors.sh --accept <name>    baseline the current findings for one mirror, then refresh it
#
# Each mirror is a bare repository directly under $MIRRORS_DIR (default ~/repos).
# A mirror with an origin URL is fetched into a scratch copy first; the commits
# that are new since the last refresh are scanned with gitleaks, and the mirror
# is updated only when the scan is clean. On a hit, or any failure, the mirror
# and its README line stay as they were and the script exits non-zero.
#
# After a clean refresh, $MIRRORS_DIR/README.md gets one line per mirror:
#   last-refresh: <name> <local time, ISO 8601> <branch>@<short sha>
# A mirror with no origin URL is fed by the owner's pushes; it is not fetched or
# scanned here, and its line shows the time of its newest commit instead.
#
# Reviewed false positives live in <mirror>/.gitleaksignore (gitleaks fingerprints).
set -uo pipefail

MIRRORS_DIR="${MIRRORS_DIR:-$HOME/repos}"
GITLEAKS="${GITLEAKS:-gitleaks}"
README="$MIRRORS_DIR/README.md"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/refresh-mirrors.$(id -u).lock"

accept=""
names=()
while [ $# -gt 0 ]; do
  case "$1" in
    --accept) accept="${2:-}"; [ -n "$accept" ] || { echo "--accept needs a mirror name" >&2; exit 2; }; names+=("$accept"); shift 2 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) names+=("$1"); shift ;;
  esac
done

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another refresh is running; skipping" >&2
  exit 0
fi

command -v "$GITLEAKS" >/dev/null || { echo "gitleaks not found ($GITLEAKS)" >&2; exit 1; }
[ -d "$MIRRORS_DIR" ] || { echo "no mirrors directory: $MIRRORS_DIR" >&2; exit 1; }
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/refresh-mirrors.XXXXXX") || exit 1
trap 'rm -rf "$SCRATCH"' EXIT

fingerprints() { grep -o '"Fingerprint": *"[^"]*"' "$1" | sed 's/.*"Fingerprint": *"//; s/"$//'; }

is_mirror() { [ "$(git -C "$1" rev-parse --is-bare-repository 2>/dev/null)" = "true" ]; }

head_label() {
  local branch sha
  branch=$(git -C "$1" symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=HEAD
  sha=$(git -C "$1" rev-parse --quiet --verify --short "$branch^{commit}" 2>/dev/null) || { echo "$branch@empty"; return; }
  echo "$branch@$sha"
}

# Replace (or append) the README line for one mirror; every other line is kept.
set_readme_line() {
  local name="$1" line="$2" tmp
  tmp=$(mktemp "$MIRRORS_DIR/.README.XXXXXX") || return 1
  if [ -f "$README" ]; then
    awk -v name="$name" -v line="$line" '
      $1 == "last-refresh:" && $2 == name { if (!done) print line; done = 1; next }
      { print }
      END { if (!done) print line }
    ' "$README" >"$tmp"
    chmod --reference="$README" "$tmp" 2>/dev/null
  else
    printf '%s\n' "$line" >"$tmp"
    chmod 644 "$tmp"
  fi
  mv -f "$tmp" "$README"
}

# Commits that are in the scratch copy but not yet in the mirror: the scratch copy
# borrows the mirror's objects, so the mirror's refs are its "alternate refs".
NEW_COMMITS="--all --not --alternate-refs"

refresh_fetched() {
  local name="$1" mirror="$2" url="$3" scratch="$SCRATCH/$1" report="$SCRATCH/$1.json" new rc found

  # The scratch copy shares the mirror's objects; only fetched objects land in it.
  git clone --quiet --mirror --shared "$mirror" "$scratch" || { echo "$name: scratch copy failed" >&2; return 1; }
  # shellcheck disable=SC2046
  git -C "$scratch" fetch --quiet --prune "$url" $(git -C "$mirror" config --get-all remote.origin.fetch) \
    || { echo "$name: fetch failed" >&2; return 1; }

  # shellcheck disable=SC2086
  new=$(git -C "$scratch" rev-list --count $NEW_COMMITS) || { echo "$name: could not list new commits" >&2; return 1; }
  if [ "$new" -gt 0 ]; then
    [ -f "$mirror/.gitleaksignore" ] && cp "$mirror/.gitleaksignore" "$scratch/"
    "$GITLEAKS" detect --no-banner --redact --source "$scratch" --log-opts "$NEW_COMMITS" \
      --report-format json --report-path "$report" >/dev/null 2>&1
    rc=$?
    found=$(fingerprints "$report" 2>/dev/null)
    if [ "$rc" -ne 0 ] && [ -z "$found" ]; then
      echo "$name: gitleaks failed (exit $rc) without a report; mirror left as it was" >&2
      return 1
    fi
    if [ -n "$found" ]; then
      echo "$name: gitleaks found possible secrets among $new new commit(s); mirror left as it was:" >&2
      sed 's/^/  /' <<<"$found" >&2
      if [ "$accept" != "$name" ]; then
        echo "$name: after review, baseline them with: $0 --accept $name" >&2
        return 1
      fi
      printf '%s\n' "$found" >>"$mirror/.gitleaksignore"
      echo "$name: baselined the findings above in $mirror/.gitleaksignore" >&2
    fi
  fi

  git -C "$mirror" fetch --quiet --prune "$scratch" '+refs/*:refs/*' || { echo "$name: updating the mirror failed" >&2; return 1; }
  set_readme_line "$name" "last-refresh: $name $(date --iso-8601=seconds) $(head_label "$mirror")"
  echo "$name: refreshed ($new new commit(s))"
}

refresh_pushed() {
  local name="$1" mirror="$2" newest
  newest=$(git -C "$mirror" for-each-ref --sort=-committerdate --count=1 --format='%(committerdate:iso-strict)' refs/heads)
  set_readme_line "$name" "last-refresh: $name ${newest:-empty} $(head_label "$mirror") (push-fed: time of newest commit)"
  echo "$name: pushed mirror, not fetched"
}

if [ ${#names[@]} -eq 0 ]; then
  for d in "$MIRRORS_DIR"/*/; do
    d="${d%/}"
    is_mirror "$d" && names+=("$(basename "$d")")
  done
fi

failed=0
for name in "${names[@]}"; do
  mirror="$MIRRORS_DIR/$name"
  if ! is_mirror "$mirror"; then
    echo "$name: not a bare repository under $MIRRORS_DIR" >&2
    failed=1
    continue
  fi
  url=$(git -C "$mirror" config --get remote.origin.url)
  if [ -n "$url" ]; then
    refresh_fetched "$name" "$mirror" "$url" || failed=1
  else
    refresh_pushed "$name" "$mirror" || failed=1
  fi
done
exit "$failed"
