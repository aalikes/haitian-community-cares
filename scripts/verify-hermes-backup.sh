#!/usr/bin/env bash
# verify-hermes-backup.sh — prove the Hermes backup is current and restorable.
# Step 3 of the runbook in docs/hermes-vps.md. Run this ON the VPS.
#
# A backup you have never restored is a hypothesis, not a backup. The failure
# mode this is built to catch: the 3AM cron still runs, the archive is still
# written, but the `git push` to aalikes/VPS-Hermes has been failing silently
# for weeks because the token expired. Everything looks fine until you need it.
#
#   ./scripts/verify-hermes-backup.sh
#   ./scripts/verify-hermes-backup.sh --extract   # also test-extract to a temp dir
#
# Read-only. --extract writes only to a temp dir it creates and removes.

set -uo pipefail

EXTRACT=0
[ "${1:-}" = "--extract" ] && EXTRACT=1

PASS=0; FAIL=0; WARN=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
warn() { echo "  WARN  $1"; WARN=$((WARN+1)); }

echo "=== Hermes backup verification — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo

# ------------------------------------------------------- 1. local archive
echo "[1] Local backup archive"
ARCHIVE="$(ls -t /root/hermes-backup*.zip "$HOME"/hermes-backup*.zip 2>/dev/null | head -1)"

SEARCHED="/root"
[ "$HOME" != "/root" ] && SEARCHED="/root or $HOME"

if [ -z "$ARCHIVE" ]; then
  bad "no hermes-backup*.zip found in ${SEARCHED} — the backup job has not produced an archive"
else
  AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$ARCHIVE") ) / 3600 ))
  SIZE="$(du -h "$ARCHIVE" | cut -f1)"
  echo "  newest: $ARCHIVE (${SIZE}, ${AGE_H}h old)"
  if   [ "$AGE_H" -le 26 ]; then ok "archive is fresh (daily cron is running)"
  elif [ "$AGE_H" -le 48 ]; then warn "archive is ${AGE_H}h old — one cycle may have been missed"
  else bad "archive is ${AGE_H}h old but the cron is daily — backups have stopped"
  fi

  # Retention is documented as 7 days; a single archive means rotation is
  # eating them or only one has ever been written.
  COUNT="$(ls -1 /root/hermes-backup*.zip "$HOME"/hermes-backup*.zip 2>/dev/null | wc -l | tr -d ' ')"
  echo "  archives on disk: ${COUNT} (7-day retention expected)"
  [ "$COUNT" -le 1 ] && warn "only ${COUNT} archive present — expected up to 7"

  # ----------------------------------------------------- 2. integrity
  echo
  echo "[2] Archive integrity"
  if command -v unzip >/dev/null 2>&1; then
    if unzip -t "$ARCHIVE" >/dev/null 2>&1; then
      ok "zip integrity check passed"
    else
      bad "zip is CORRUPT — unzip -t failed. Do not rely on this archive."
    fi

    echo
    echo "[3] Archive contents (expect: config, skills, sessions, memory)"
    for want in config skill session memory; do
      if unzip -l "$ARCHIVE" 2>/dev/null | grep -qi "$want"; then
        ok "contains something matching '${want}'"
      else
        warn "nothing matching '${want}' in the archive"
      fi
    done
    echo "  --- top-level entries ---"
    unzip -l "$ARCHIVE" 2>/dev/null | awk 'NR>3 && NF>=4 {print $4}' \
      | cut -d/ -f1 | sort -u | head -20 | sed 's/^/    /'
  else
    warn "unzip not installed — cannot verify integrity (apt install unzip)"
  fi

  # ----------------------------------------------------- 4. test extract
  if [ "$EXTRACT" -eq 1 ] && command -v unzip >/dev/null 2>&1; then
    echo
    echo "[4] Test extraction"
    TMPD="$(mktemp -d /tmp/hermes-restore-test-XXXXXX)"
    if unzip -q "$ARCHIVE" -d "$TMPD" 2>/dev/null; then
      N="$(find "$TMPD" -type f | wc -l | tr -d ' ')"
      ok "extracted ${N} files cleanly to a temp dir"
      echo "  --- extracted tree (2 levels) ---"
      find "$TMPD" -maxdepth 2 | head -25 | sed "s|$TMPD|  .|"
    else
      bad "extraction failed — the archive will not restore"
    fi
    rm -rf "$TMPD"
    echo "  (temp dir removed)"
  fi
fi

# ------------------------------------------------------- 5. github push
echo
echo "[5] GitHub backup repo (aalikes/VPS-Hermes)"
REPO=""
for d in "$HOME/VPS-Hermes" /root/VPS-Hermes "$HOME/hermes-backup" /root/hermes-backup; do
  [ -d "$d/.git" ] && { REPO="$d"; break; }
done

if [ -z "$REPO" ]; then
  warn "no local clone of the backup repo found — the cron may push from a temp dir"
  echo "  Check by hand: grep -r 'git push' /root/hermes-backup.sh"
else
  echo "  repo: $REPO"
  LAST_TS="$(git -C "$REPO" log -1 --format=%ct 2>/dev/null || echo 0)"
  if [ "$LAST_TS" -gt 0 ]; then
    PUSH_AGE=$(( ( $(date +%s) - LAST_TS ) / 3600 ))
    echo "  newest commit: $(git -C "$REPO" log -1 --format='%h %ad %s' --date=iso 2>/dev/null)"
    if   [ "$PUSH_AGE" -le 26 ]; then ok "backup commits are current"
    elif [ "$PUSH_AGE" -le 48 ]; then warn "newest commit is ${PUSH_AGE}h old"
    else bad "newest commit is ${PUSH_AGE}h old — pushes stopped $(( PUSH_AGE / 24 )) days ago"
    fi
  fi

  # Unpushed commits are the smoking gun for an expired credential: the cron
  # keeps committing locally, the push fails, nobody notices.
  #
  # Check the upstream exists first. Without this, `log @{u}..` fails, the
  # count comes back 0, and a repo that was NEVER wired to a remote looks
  # identical to one that is perfectly in sync.
  if git -C "$REPO" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    UNPUSHED="$(git -C "$REPO" log --oneline '@{u}..' 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${UNPUSHED:-0}" -gt 0 ]; then
      bad "${UNPUSHED} commit(s) committed locally but never pushed — the credential has almost certainly expired"
      git -C "$REPO" log --oneline '@{u}..' 2>/dev/null | head -5 | sed 's/^/    /'
    else
      ok "no unpushed commits — local and remote are in sync"
    fi
  else
    bad "no upstream branch configured for $(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null) — commits here were never pushed anywhere"
  fi

  # Read-only auth probe: does the stored credential still work?
  echo "  testing remote auth (read-only)..."
  if timeout 25 git -C "$REPO" ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
    ok "remote is reachable and the stored credential still authenticates"
  else
    bad "cannot authenticate to the remote — expired PAT or revoked deploy key. This is why pushes stopped."
  fi
fi

# ------------------------------------------------------- 6. the cron itself
echo
echo "[6] Backup cron"
if [ -f /root/hermes-backup.sh ]; then
  ok "/root/hermes-backup.sh exists"
  echo "  last modified: $(stat -c %y /root/hermes-backup.sh 2>/dev/null)"
else
  bad "/root/hermes-backup.sh is missing — the documented backup script is gone"
fi

if crontab -l 2>/dev/null | grep -q 'hermes-backup'; then
  ok "backup entry present in root crontab"
  crontab -l 2>/dev/null | grep 'hermes-backup' | sed 's/^/    /'
else
  warn "no hermes-backup entry in root crontab (check /etc/cron.d and other users)"
fi

# ------------------------------------------------------------------ verdict
echo
echo "=== VERDICT ==="
echo "  ${PASS} passed, ${WARN} warnings, ${FAIL} failures"
echo
if [ "$FAIL" -gt 0 ]; then
  echo "  DO NOT REBUILD YET. The backup cannot be trusted to restore."
  echo "  Fix the failures above, force a fresh backup (/root/hermes-backup.sh),"
  echo "  re-run this, and only then consider rebuilding."
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "  Backup is probably usable, but read the warnings before rebuilding."
  exit 0
else
  echo "  Backup is current, intact and restorable. Safe to proceed."
  exit 0
fi
