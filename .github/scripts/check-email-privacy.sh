#!/usr/bin/env bash
# Fails if any commit in the given list leaks a private maintainer email.
#
# Usage: check-email-privacy.sh <rev-list args...>
#   e.g. check-email-privacy.sh BASE..HEAD
#        check-email-privacy.sh HEAD --not --remotes=origin
#
# Rules, checked on author, committer, and every email in the message
# (including Co-authored-by trailers):
#   1. An identity named like the maintainer ("Liam Smith", "L S", "Ihlathi")
#      must use the GitHub noreply address below.
#   2. No email may match a blocked private address. Blocked addresses are
#      stored only as SHA-256 hashes of the normalized mailbox name
#      (lowercase, "+tag" and dots removed), so this file never names them.
set -euo pipefail

NOREPLY="117225293+Ihlathi@users.noreply.github.com"
NAME_RE='^(liam smith|l s|ihlathi)$'
BLOCKED_HASHES=(
  15a8f52977666dda1ce774620465e981c676d362dbff34e390f2422817d8289e
  bba34121ca13ebc10c37e76afde09760f51e52e3aac95b60925d35d217310d99
)

failures=0

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

is_blocked_email() {
  local email local_part hash h
  email=$(lower "$1")
  local_part=${email%%@*}
  local_part=${local_part%%+*}
  local_part=${local_part//./}
  hash=$(printf '%s' "$local_part" | sha256sum | cut -d' ' -f1)
  for h in "${BLOCKED_HASHES[@]}"; do
    [[ "$hash" == "$h" ]] && return 0
  done
  return 1
}

report() {
  # $1 commit, $2 where, $3 reason. Never echo the email itself.
  echo "::error::Commit ${1:0:12}: $2 $3"
  failures=$((failures + 1))
}

check_identity() {
  # $1 commit, $2 where, $3 name, $4 email
  local name email
  name=$(lower "$3" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
  email=$(lower "$4")
  local noreply
  noreply=$(lower "$NOREPLY")
  if is_blocked_email "$email"; then
    report "$1" "$2" "uses a blocked private email address."
  elif [[ "$name" =~ $NAME_RE && "$email" != "$noreply" ]]; then
    report "$1" "$2" "is named '$3' but does not use the GitHub noreply address ($NOREPLY)."
  fi
}

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <rev-list args>" >&2
  exit 2
fi

mapfile -t commits < <(git rev-list "$@")
echo "Checking ${#commits[@]} commit(s) for private email addresses."

for c in "${commits[@]}"; do
  IFS=$'\x1f' read -r an ae cn ce < <(git log -1 --format='%an%x1f%ae%x1f%cn%x1f%ce' "$c")
  check_identity "$c" "author" "$an" "$ae"
  check_identity "$c" "committer" "$cn" "$ce"

  msg=$(git log -1 --format='%B' "$c")
  # Co-authored-by trailers: check name + email pairs.
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*[Cc]o-[Aa]uthored-[Bb]y:[[:space:]]*(.*[^[:space:]])[[:space:]]*\<([^>]*)\> ]]; then
      check_identity "$c" "Co-authored-by trailer" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    fi
  done <<<"$msg"
  # Any other email-looking text in the message.
  while IFS= read -r email; do
    [[ -z "$email" ]] && continue
    if is_blocked_email "$email"; then
      report "$c" "message" "contains a blocked private email address."
    fi
  done < <(grep -oiE '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]+' <<<"$msg" | sort -u || true)
done

if [[ $failures -gt 0 ]]; then
  echo
  echo "Found $failures private-email problem(s)."
  echo "Fix: git config user.email '$NOREPLY', drop the offending Co-authored-by lines,"
  echo "then rewrite these commits (e.g. git rebase -i with 'git commit --amend --reset-author')."
  exit 1
fi
echo "OK: no private email addresses found."
