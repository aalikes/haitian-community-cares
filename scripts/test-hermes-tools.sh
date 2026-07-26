#!/usr/bin/env bash
# test-hermes-tools.sh — regression suite for the Hermes tooling.
#
# Run this after changing any script in this directory. It exercises the real
# scripts against the local machine; nothing here touches a VPS, and no test
# mutates system state.
#
#   ./scripts/test-hermes-tools.sh
#
# Exits non-zero if any check fails.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PASS=0; FAIL=0
chk() {
  if eval "$2" >/dev/null 2>&1; then
    echo "  PASS  $1"; PASS=$((PASS+1))
  else
    echo "  FAIL  $1"; FAIL=$((FAIL+1))
  fi
}

echo "=== syntax ==="
for f in scripts/*.sh; do
  chk "bash -n $(basename "$f")" "bash -n '$f'"
done

echo "=== lint ==="
if command -v shellcheck >/dev/null 2>&1; then
  chk "shellcheck -S warning (all)" "shellcheck -S warning scripts/*.sh"
  chk "shellcheck -S info (all)"    "shellcheck -S info scripts/*.sh"
else
  echo "  SKIP  shellcheck not installed"
fi

echo "=== diagnose ==="
chk "runs to completion"           "bash scripts/diagnose-hermes.sh --summary"
chk "--redact masks IPs"           "bash scripts/diagnose-hermes.sh --redact | grep '<IP>' >/dev/null"
chk "rejects unknown flags"        "! bash scripts/diagnose-hermes.sh --bogus"

echo "=== verify-backup ==="
# No archive present here, so it must fail loudly rather than pass by default.
chk "exits non-zero with no backup" "! bash scripts/verify-hermes-backup.sh"

# Retention count must not double when HOME is /root — globbing both paths
# used to list every archive twice and hide a rotation failure.
TMPMARK=0
for i in 1 2 3; do touch "/root/hermes-backup-test-20260${i}01.zip" 2>/dev/null && TMPMARK=1; done
if [ "$TMPMARK" = "1" ]; then
  # `|| true` because verify legitimately exits 1 here (no valid backup); this
  # assertion is about the count in its output, not its exit status.
  chk "counts 3 archives, not 6" \
      "{ HOME=/root bash scripts/verify-hermes-backup.sh 2>&1 || true; } | grep 'archives on disk: 3' >/dev/null"
  rm -f /root/hermes-backup-test-2026*.zip
else
  echo "  SKIP  retention count (cannot write to /root)"
fi

echo "=== harden ==="
chk "dry run makes no changes"     "bash scripts/harden-hermes.sh | grep 'WOULD DO' >/dev/null"
chk "dry run says DRY RUN"         "bash scripts/harden-hermes.sh | grep 'DRY RUN' >/dev/null"
chk "defaults to root"             "bash scripts/harden-hermes.sh | grep 'user: root' >/dev/null"
chk "--user override honoured"     "bash scripts/harden-hermes.sh --user nobody | grep nobody >/dev/null"
chk "--user without value rejected" "! bash scripts/harden-hermes.sh --user"
chk "rejects unknown flags"        "! bash scripts/harden-hermes.sh --bogus"

echo "=== snapshot ==="
chk "guards missing HCLOUD_TOKEN"  "! env -u HCLOUD_TOKEN bash scripts/snapshot-hermes.sh"
chk "bare --server rejected"       "! timeout 5 bash scripts/snapshot-hermes.sh --server"
chk "bare --server does not hang"  "timeout 5 bash scripts/snapshot-hermes.sh --server; [ \$? -ne 124 ]"
chk "rejects unknown flags"        "! bash scripts/snapshot-hermes.sh --bogus"

echo "=== rescue ==="
# Same as above: rescue exits 1 by design when the backup cannot be verified.
# This asserts it still reached the diagnostics stage.
chk "chains through to findings"   "{ bash scripts/rescue-hermes.sh --no-backup || true; } | grep FINDINGS >/dev/null"
chk "gates on unverifiable backup" "! bash scripts/rescue-hermes.sh --no-backup"
chk "rejects unknown flags"        "! bash scripts/rescue-hermes.sh --bogus"

echo "=== permissions ==="
for f in scripts/*.sh; do
  chk "executable: $(basename "$f")" "test -x '$f'"
done

echo
echo "=== ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
