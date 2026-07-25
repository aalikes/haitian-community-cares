#!/usr/bin/env bash
# harden-hermes.sh — fix the four known config gaps on the Hermes VPS.
# Step 5 of the runbook in docs/hermes-vps.md. Run this ON the VPS, as root.
#
# Unlike diagnose-hermes.sh, this script CHANGES THE SYSTEM. It is dry-run by
# default and prints exactly what it would do; nothing happens without --apply.
# Every action is idempotent — running it twice is safe and the second run is
# a no-op.
#
#   ./scripts/harden-hermes.sh            # dry run, show the plan
#   ./scripts/harden-hermes.sh --apply    # actually make the changes
#
# What it fixes, and why:
#   1. No swap        — 4GB CPX22 running Node, one traffic spike from an OOM kill
#   2. No logrotate   — cron scripts append to ~/logs/*.log forever until disk full
#   3. Linger         — without it a systemd *user* unit dies at logout and reboot
#   4. Journal cap    — journald defaults to 10% of disk
#
# Take a snapshot first (scripts/snapshot-hermes.sh). This does not touch
# Hermes itself, its config, or its data.

set -uo pipefail

APPLY=0
SWAP_GB=2
[ "${1:-}" = "--apply" ] && APPLY=1
case "${1:-}" in
  -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
  --apply|"") ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root — swap, logrotate and journald all need it." >&2
  echo "  sudo $0 ${1:-}" >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-root}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TARGET_HOME="${TARGET_HOME:-/root}"

CHANGES=0
if [ "$APPLY" -eq 1 ]; then
  echo "=== APPLYING CHANGES (user: ${TARGET_USER}, home: ${TARGET_HOME}) ==="
else
  echo "=== DRY RUN — nothing will be changed. Re-run with --apply to commit. ==="
  echo "    (user: ${TARGET_USER}, home: ${TARGET_HOME})"
fi
echo

# do <description> <<'SCRIPT'  — run a block only under --apply
do_step() {
  local desc="$1"
  CHANGES=$((CHANGES+1))
  if [ "$APPLY" -eq 1 ]; then
    echo "  APPLYING: ${desc}"
    return 0
  else
    echo "  WOULD DO: ${desc}"
    return 1
  fi
}

# ------------------------------------------------------------------ 1. swap
echo "[1] Swap"
SWAP_TOTAL="$(awk '/SwapTotal/{print $2}' /proc/meminfo)"
if [ "${SWAP_TOTAL:-0}" -gt 0 ]; then
  echo "  OK — ${SWAP_TOTAL} kB of swap already active. Nothing to do."
elif [ -f /swapfile ]; then
  echo "  /swapfile exists but is not active."
  if do_step "swapon /swapfile"; then
    swapon /swapfile && echo "    enabled."
  fi
else
  AVAIL_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
  if [ "${AVAIL_GB:-0}" -lt $((SWAP_GB + 5)) ]; then
    echo "  SKIP — only ${AVAIL_GB}GB free on /; refusing to add a ${SWAP_GB}GB swapfile."
    echo "         Free up disk first (see the log rotation step below)."
  else
    if do_step "create a ${SWAP_GB}GB swapfile at /swapfile, enable it, persist in /etc/fstab"; then
      if fallocate -l "${SWAP_GB}G" /swapfile 2>/dev/null \
         || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB*1024)) status=none; then
        chmod 600 /swapfile
        mkswap /swapfile >/dev/null
        swapon /swapfile
        if ! grep -q '^/swapfile' /etc/fstab; then
          printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
          echo "    added to /etc/fstab (survives reboot)."
        fi
        # Prefer RAM, use swap as the safety net rather than routine storage.
        sysctl -q vm.swappiness=10
        grep -q '^vm.swappiness' /etc/sysctl.conf 2>/dev/null \
          || printf 'vm.swappiness=10\n' >> /etc/sysctl.conf
        echo "    ${SWAP_GB}GB swap active, swappiness=10."
      else
        echo "    FAILED to allocate the swapfile." >&2
      fi
    fi
  fi
fi

# ------------------------------------------------------------- 2. logrotate
echo
echo "[2] Log rotation for ${TARGET_HOME}/logs/*.log"
if [ -f /etc/logrotate.d/hermes ]; then
  echo "  OK — /etc/logrotate.d/hermes already exists. Nothing to do."
else
  if [ ! -d "${TARGET_HOME}/logs" ]; then
    echo "  NOTE — ${TARGET_HOME}/logs does not exist yet; installing the rule anyway"
    echo "         so it takes effect as soon as the cron scripts start writing."
  else
    echo "  current size: $(du -sh "${TARGET_HOME}/logs" 2>/dev/null | cut -f1)"
  fi
  if do_step "install /etc/logrotate.d/hermes (daily, keep 14, compress)"; then
    cat > /etc/logrotate.d/hermes <<EOF
${TARGET_HOME}/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su ${TARGET_USER} ${TARGET_USER}
}
EOF
    echo "    written. Verifying config parses..."
    if logrotate -d /etc/logrotate.d/hermes >/dev/null 2>&1; then
      echo "    config is valid."
    else
      echo "    WARNING: logrotate rejected the config — check it by hand:" >&2
      logrotate -d /etc/logrotate.d/hermes 2>&1 | head -10 >&2
    fi
  fi
fi
# copytruncate matters here: the cron scripts hold their log open with >>, so
# renaming out from under them would leave them writing to a deleted inode.

# ---------------------------------------------------------------- 3. linger
echo
echo "[3] Linger for ${TARGET_USER} (keeps hermes-gateway alive across reboots)"
LINGER="$(loginctl show-user "$TARGET_USER" --property=Linger 2>/dev/null | cut -d= -f2)"
case "${LINGER:-}" in
  yes) echo "  OK — linger already enabled. Nothing to do." ;;
  no)
    if do_step "loginctl enable-linger ${TARGET_USER}"; then
      loginctl enable-linger "$TARGET_USER" && echo "    enabled — the user manager now starts at boot."
    fi ;;
  *)  echo "  UNKNOWN — could not read linger state for ${TARGET_USER}." ;;
esac

# --------------------------------------------------------------- 4. journal
echo
echo "[4] Journald size cap"
if grep -qE '^\s*SystemMaxUse=' /etc/systemd/journald.conf 2>/dev/null; then
  echo "  OK — SystemMaxUse already set: $(grep -E '^\s*SystemMaxUse=' /etc/systemd/journald.conf)"
else
  echo "  current journal usage: $(journalctl --disk-usage 2>/dev/null | tail -1)"
  if do_step "set SystemMaxUse=500M in /etc/systemd/journald.conf and restart journald"; then
    cp /etc/systemd/journald.conf /etc/systemd/journald.conf.bak-"$(date -u +%Y%m%d)" 2>/dev/null
    printf '\n# capped by harden-hermes.sh\nSystemMaxUse=500M\n' >> /etc/systemd/journald.conf
    systemctl restart systemd-journald && echo "    applied and journald restarted."
  fi
fi

# ----------------------------------------------------------------- summary
echo
echo "=== SUMMARY ==="
if [ "$APPLY" -eq 1 ]; then
  echo "  Changes applied. Verify with:"
  echo "    free -h                      # swap should be visible"
  echo "    loginctl show-user ${TARGET_USER} -p Linger"
  echo "    logrotate -d /etc/logrotate.d/hermes"
  echo
  echo "  Then re-run the diagnostics to confirm the findings clear:"
  echo "    ./scripts/diagnose-hermes.sh --summary"
  echo
  echo "  Reboot test: linger is only truly proven by rebooting and confirming"
  echo "  hermes-gateway comes back on its own. Do that while you are watching,"
  echo "  not at 3AM on a Friday."
else
  echo "  ${CHANGES} change(s) would be made. Nothing was modified."
  echo "  Re-run with --apply to commit them:"
  echo "    sudo $0 --apply"
fi
