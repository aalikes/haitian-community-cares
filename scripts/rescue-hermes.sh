#!/usr/bin/env bash
# rescue-hermes.sh — force a fresh backup, prove it is good, then diagnose.
# Run this ON the VPS. One command instead of three, in the order that keeps
# your data safest.
#
#   ./scripts/rescue-hermes.sh              # backup + verify + diagnose
#   ./scripts/rescue-hermes.sh --no-backup  # verify + diagnose only
#
# Order matters and is deliberate:
#   1. BACKUP first  — if the 3AM cron has been silently failing, the state on
#                      this box is the only copy. Capture it before anything
#                      else, including before poking at the service.
#   2. VERIFY next   — a backup you have not verified is a hypothesis.
#   3. DIAGNOSE last — read-only, so it is safe once the data is secured.
#
# The only thing this mutates is creating a new backup archive (additive — it
# does not delete or overwrite prior archives). Everything else is read-only.
#
# TAKE A HETZNER SNAPSHOT FIRST if you have not already:
#   ./scripts/snapshot-hermes.sh        (run from your workstation)

set -uo pipefail

DO_BACKUP=1
[ "${1:-}" = "--no-backup" ] && DO_BACKUP=0
case "${1:-}" in
  -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
  --no-backup|"") ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BUNDLE_DIR="/tmp/hermes-rescue-${TS}"
mkdir -p "$BUNDLE_DIR"

echo "=== Hermes rescue — ${TS} ==="
echo "Collecting into ${BUNDLE_DIR}"
echo

BACKUP_RC="skipped"
VERIFY_RC="skipped"

# ------------------------------------------------------------ 1. backup
if [ "$DO_BACKUP" -eq 1 ]; then
  echo "--- [1/3] Forcing a fresh backup ---"
  if [ -x /root/hermes-backup.sh ]; then
    if /root/hermes-backup.sh 2>&1 | tee "${BUNDLE_DIR}/backup.log"; then
      echo "Backup script completed."
      BACKUP_RC="ok"
    else
      echo "Backup script exited non-zero — see ${BUNDLE_DIR}/backup.log" >&2
      BACKUP_RC="failed"
    fi
  elif [ -f /root/hermes-backup.sh ]; then
    echo "/root/hermes-backup.sh exists but is not executable." >&2
    echo "Run it explicitly:  bash /root/hermes-backup.sh" >&2
    BACKUP_RC="not-executable"
  else
    echo "/root/hermes-backup.sh is MISSING." >&2
    echo
    echo "Fall back to Hermes' own export — check the exact flag with 'hermes --help':" >&2
    echo "  hermes export ~/hermes-backup-manual-${TS}.zip" >&2
    echo
    echo "Whatever it produces, get a copy OFF this box before going further." >&2
    BACKUP_RC="missing-script"
  fi
  echo
else
  echo "--- [1/3] Backup skipped (--no-backup) ---"
  echo
fi

# ------------------------------------------------------------ 2. verify
echo "--- [2/3] Verifying the backup ---"
if [ -x "${HERE}/verify-hermes-backup.sh" ]; then
  "${HERE}/verify-hermes-backup.sh" --extract 2>&1 | tee "${BUNDLE_DIR}/verify.log"
  VERIFY_RC="${PIPESTATUS[0]}"
  [ "$VERIFY_RC" = "0" ] && VERIFY_RC="ok" || VERIFY_RC="FAILED"
else
  echo "verify-hermes-backup.sh not found next to this script." >&2
  VERIFY_RC="script-missing"
fi
echo

# ------------------------------------------------------------ 3. diagnose
echo "--- [3/3] Diagnostics ---"
if [ -x "${HERE}/diagnose-hermes.sh" ]; then
  "${HERE}/diagnose-hermes.sh" --redact > "${BUNDLE_DIR}/diagnose.log" 2>&1
  echo "Diagnostics written to ${BUNDLE_DIR}/diagnose.log"
  echo
  sed -n '/===== FINDINGS =====/,$p' "${BUNDLE_DIR}/diagnose.log"
else
  echo "diagnose-hermes.sh not found next to this script." >&2
fi

# ------------------------------------------------------------- bundle
echo
echo "=== SUMMARY ==="
echo "  backup:      ${BACKUP_RC}"
echo "  verify:      ${VERIFY_RC}"
echo "  bundle dir:  ${BUNDLE_DIR}"

TARBALL="/tmp/hermes-rescue-${TS}.tar.gz"
if tar czf "$TARBALL" -C /tmp "hermes-rescue-${TS}" 2>/dev/null; then
  echo "  tarball:     ${TARBALL}"
  echo
  echo "Copy it off the box:"
  echo "  scp root@<host>:${TARBALL} ."
fi

echo
if [ "$VERIFY_RC" = "FAILED" ]; then
  echo "  VERDICT: backup is NOT trustworthy. Do not rebuild or destroy anything."
  echo "           Fix the backup path first — verify.log says which check failed."
  exit 1
fi
echo "  Diagnostics were run with --redact, but read diagnose.log before sharing it."
