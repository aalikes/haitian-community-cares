#!/usr/bin/env bash
# diagnose-hermes.sh — read-only health snapshot for the Hermes VPS (hermes-falkenstein-2).
#
# Collects a full picture of the box and the Hermes agent stack, then prints a
# FINDINGS summary that flags the things most likely to have broken.
#
# Usage:
#   ./diagnose-hermes.sh              # full report -> stdout + /tmp/hermes-diag-<ts>.txt
#   ./diagnose-hermes.sh --redact     # mask IPs, emails, tokens before sharing
#   ./diagnose-hermes.sh --summary    # findings only, skip the raw dumps
#
# Read-only: nothing here restarts, edits, installs, or deletes anything.

set -uo pipefail

REDACT=0
SUMMARY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --redact)  REDACT=1 ;;
    --summary) SUMMARY_ONLY=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="/tmp/hermes-diag-${TS}.txt"
FINDINGS=()

# Everything below is captured to $OUT so --redact can scrub the whole report
# before any of it reaches a terminal. fd 3 keeps a handle on the real stdout.
exec 3>&1
exec >"$OUT" 2>&1

# Hermes runs as a systemd *user* service with linger. Figure out whose.
HERMES_USER="${SUDO_USER:-$(id -un)}"
HERMES_HOME="$(getent passwd "$HERMES_USER" | cut -d: -f6)"
HERMES_HOME="${HERMES_HOME:-$HOME}"

have() { command -v "$1" >/dev/null 2>&1; }

section() {
  [ "$SUMMARY_ONLY" -eq 1 ] && return 0
  printf '\n\n===== %s =====\n' "$1"
}

# run <label> <command...> — never let a missing binary abort the run.
run() {
  local label="$1"; shift
  [ "$SUMMARY_ONLY" -eq 1 ] && return 0
  printf '\n--- %s ---\n' "$label"
  if ! "$@" 2>&1; then
    printf '(command failed or unavailable: %s)\n' "$*"
  fi
}

note() { FINDINGS+=("$1"); }

# ---------------------------------------------------------------- identity
section "IDENTITY"
run "host"    hostnamectl
run "uptime"  uptime
run "kernel"  uname -a
run "os"      cat /etc/os-release
run "whoami"  id
[ -f /etc/cloud/cloud.cfg ] && run "cloud-init" cloud-init status 2>/dev/null

# ---------------------------------------------------------------- resources
section "CPU / LOAD"
run "loadavg" cat /proc/loadavg
run "cpuinfo" lscpu
have top && run "top" top -b -n1 -o %CPU

CORES="$(nproc 2>/dev/null || echo 1)"
LOAD1="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)"
if awk -v l="$LOAD1" -v c="$CORES" 'BEGIN{exit !(l > c*2)}'; then
  note "WARN  load average ${LOAD1} is over 2x the ${CORES} available cores — something is saturating CPU."
fi

section "MEMORY"
run "free"    free -h
run "meminfo" head -20 /proc/meminfo
run "top-mem" bash -c "ps aux --sort=-%mem | head -15"

MEM_TOTAL="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
MEM_AVAIL="$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
SWAP_TOTAL="$(awk '/SwapTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$MEM_TOTAL" -gt 0 ]; then
  MEM_PCT=$(( MEM_AVAIL * 100 / MEM_TOTAL ))
  [ "$MEM_PCT" -lt 10 ] && note "CRIT  only ${MEM_PCT}% of RAM available — OOM kill is imminent."
  [ "$MEM_PCT" -ge 10 ] && [ "$MEM_PCT" -lt 20 ] && note "WARN  only ${MEM_PCT}% of RAM available."
fi
if [ "$SWAP_TOTAL" -eq 0 ]; then
  note "INFO  no swap configured (Hetzner default). On a 4GB CPX22 running Node, a 2GB swapfile is cheap insurance against OOM kills."
fi

section "DISK"
run "df"      df -h
run "inodes"  df -i
run "biggest" bash -c "du -xh / --max-depth=2 2>/dev/null | sort -rh | head -25"

while read -r pct mnt; do
  [ -z "${pct:-}" ] && continue
  [ "$pct" -ge 95 ] && note "CRIT  filesystem ${mnt} is ${pct}% full — writes are about to start failing."
  [ "$pct" -ge 85 ] && [ "$pct" -lt 95 ] && note "WARN  filesystem ${mnt} is ${pct}% full."
done < <(df -P 2>/dev/null | awk 'NR>1 && $5 ~ /%/ {gsub(/%/,"",$5); print $5, $6}')

while read -r pct mnt; do
  [ -z "${pct:-}" ] && continue
  [ "$pct" -ge 85 ] && note "WARN  filesystem ${mnt} is at ${pct}% inode usage — lots of small files (often unrotated logs or backup dirs)."
done < <(df -iP 2>/dev/null | awk 'NR>1 && $5 ~ /%/ {gsub(/%/,"",$5); print $5, $6}')

# ---------------------------------------------------------------- hermes
section "HERMES SERVICE"
run "hermes version" hermes --version
run "gateway status" hermes gateway status
run "user unit"      systemctl --user status hermes-gateway --no-pager -l
run "user units"     systemctl --user list-units --type=service --all --no-pager
run "linger"         loginctl show-user "$HERMES_USER" --property=Linger

GW_STATE="$(systemctl --user is-active hermes-gateway 2>/dev/null || echo unknown)"
case "$GW_STATE" in
  active) ;;
  unknown) note "WARN  could not query the hermes-gateway user unit — run this script as the user that owns it (currently: ${HERMES_USER}), not via plain sudo." ;;
  *) note "CRIT  hermes-gateway is '${GW_STATE}', not active. This is why Hermes is not answering in Slack." ;;
esac

LINGER="$(loginctl show-user "$HERMES_USER" --property=Linger 2>/dev/null | cut -d= -f2)"
if [ "${LINGER:-}" = "no" ]; then
  note "CRIT  linger is disabled for ${HERMES_USER} — the user manager is torn down on logout, so hermes-gateway will not survive a reboot. Fix: loginctl enable-linger ${HERMES_USER}"
fi

RESTARTS="$(systemctl --user show hermes-gateway --property=NRestarts 2>/dev/null | cut -d= -f2)"
if [ -n "${RESTARTS:-}" ] && [ "${RESTARTS:-0}" -gt 5 ] 2>/dev/null; then
  note "WARN  hermes-gateway has restarted ${RESTARTS} times — it is crash-looping rather than running cleanly. Check the gateway log below for the repeating error."
fi

section "HERMES LOGS"
run "gateway log (200)"  journalctl --user -u hermes-gateway -n 200 --no-pager
run "gateway errors"     journalctl --user -u hermes-gateway -p err -n 60 --no-pager
run "since boot"         journalctl --user -u hermes-gateway -b --no-pager -n 40

# Slack Socket Mode is an outbound WSS connection; disconnect storms are the
# classic symptom of an expired app token or upstream flakiness.
if journalctl --user -u hermes-gateway -n 500 --no-pager 2>/dev/null \
   | grep -qiE 'socket.?mode.*(disconnect|reconnect)|websocket.*(closed|error)'; then
  note "WARN  Slack Socket Mode disconnect/reconnect entries in the gateway log — check the xapp app-level token has not been revoked or expired."
fi
if journalctl --user -u hermes-gateway -n 500 --no-pager 2>/dev/null \
   | grep -qiE 'invalid_auth|not_authed|token_revoked|account_inactive'; then
  note "CRIT  Slack auth errors in the gateway log (invalid_auth / token_revoked) — the bot or app token needs rotating."
fi
if journalctl --user -u hermes-gateway -n 500 --no-pager 2>/dev/null \
   | grep -qiE 'deepseek|insufficient.?balance|rate.?limit|429|401 unauthorized'; then
  note "WARN  model-API errors in the gateway log — check the DeepSeek key is valid and the account has balance (Hermes talks to DeepSeek directly, so a billing lapse looks like a dead agent)."
fi

# ---------------------------------------------------------------- backups
section "BACKUPS"
run "backup script"  ls -l /root/hermes-backup.sh
run "root crontab"   crontab -l
run "user crontab"   bash -c "crontab -u '$HERMES_USER' -l"
run "cron.d"         bash -c "ls -l /etc/cron.d/ && cat /etc/cron.d/* 2>/dev/null"
run "cron log"       journalctl -u cron -n 60 --no-pager
run "backup files"   bash -c "ls -lht /root/hermes-backup*.zip ~/hermes-backup*.zip 2>/dev/null | head"

# The backup is a daily 3AM UTC cron that pushes to github.com/aalikes/VPS-Hermes.
# A silently-expired git credential is the most common way this dies.
LATEST_BACKUP="$(ls -t /root/hermes-backup*.zip "$HERMES_HOME"/hermes-backup*.zip 2>/dev/null | head -1)"
if [ -n "${LATEST_BACKUP:-}" ]; then
  AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$LATEST_BACKUP" 2>/dev/null || echo 0) ) / 3600 ))
  [ "$AGE_H" -gt 48 ] && note "WARN  newest local backup is ${AGE_H}h old (expected daily) — the 3AM cron is not completing."
else
  note "WARN  no local hermes-backup*.zip found — either retention cleaned them all or the backup job never ran."
fi

for d in "$HERMES_HOME/VPS-Hermes" /root/VPS-Hermes "$HERMES_HOME/Projects/hermes-agents"; do
  [ -d "$d/.git" ] || continue
  run "git status: $d" git -C "$d" status -sb
  run "git last: $d"   git -C "$d" log -3 --oneline --date=relative --pretty='%h %ad %s'
  LAST_PUSH="$(git -C "$d" log -1 --format=%ct 2>/dev/null || echo 0)"
  if [ "$LAST_PUSH" -gt 0 ]; then
    PUSH_AGE=$(( ( $(date +%s) - LAST_PUSH ) / 3600 ))
    [ "$PUSH_AGE" -gt 48 ] && note "WARN  ${d}: newest commit is ${PUSH_AGE}h old — backup pushes to GitHub have stopped (usually an expired PAT or deploy key)."
  fi
done

# ---------------------------------------------------------------- cron jobs
section "CRON SCRIPTS & LOGS"
run "scripts dir" bash -c "ls -lR '$HERMES_HOME/scripts' 2>/dev/null | head -60"
run "log dir"     bash -c "ls -lh '$HERMES_HOME/logs' 2>/dev/null"
run "log tails"   bash -c "for f in '$HERMES_HOME'/logs/*.log; do [ -f \"\$f\" ] && { echo \"### \$f\"; tail -20 \"\$f\"; }; done 2>/dev/null"

# The documented cron scripts append with >> and no logrotate config, so these
# grow without bound until the disk fills.
if [ -d "$HERMES_HOME/logs" ]; then
  LOG_KB="$(du -sk "$HERMES_HOME/logs" 2>/dev/null | cut -f1)"
  if [ "${LOG_KB:-0}" -gt 1048576 ]; then
    note "WARN  ${HERMES_HOME}/logs is $(( LOG_KB / 1024 ))MB. The cron scripts append with '>>' and there is no logrotate rule for them — this grows until the disk fills."
  fi
  BIG_LOG="$(find "$HERMES_HOME/logs" -name '*.log' -size +100M 2>/dev/null | head -3)"
  [ -n "$BIG_LOG" ] && note "WARN  unrotated log files over 100MB: $(echo "$BIG_LOG" | tr '\n' ' ')"
fi
if ! ls /etc/logrotate.d/hermes* >/dev/null 2>&1; then
  note "INFO  no /etc/logrotate.d/hermes rule exists — worth adding one for ~/logs/*.log before it becomes a disk-full incident."
fi

# ---------------------------------------------------------------- system
section "SYSTEMD / ERRORS"
run "failed units" systemctl --failed --no-pager
run "boot errors"  journalctl -p err -b --no-pager -n 80
run "dmesg tail"   bash -c "dmesg -T 2>/dev/null | tail -60"
run "journal size" journalctl --disk-usage

FAILED_N="$(systemctl --failed --no-legend --no-pager 2>/dev/null | wc -l | tr -d ' ')"
[ "${FAILED_N:-0}" -gt 0 ] && note "WARN  ${FAILED_N} failed systemd unit(s) — see the FAILED UNITS section."

if journalctl -k -b --no-pager 2>/dev/null | grep -qiE 'out of memory|oom-kill|killed process'; then
  note "CRIT  the kernel OOM killer has fired this boot. On a 4GB box this is the single most likely reason Hermes died. Check dmesg for which process it killed."
fi
if dmesg -T 2>/dev/null | grep -qiE 'I/O error|EXT4-fs error|blk_update_request'; then
  note "CRIT  disk I/O errors in dmesg — check the Hetzner console for volume health."
fi

JOURNAL_MB="$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[MG]' | head -1)"
case "${JOURNAL_MB:-}" in
  *G) note "INFO  journald is using ${JOURNAL_MB}. Cap it with SystemMaxUse=500M in /etc/systemd/journald.conf if disk is tight." ;;
esac

section "UPDATES / REBOOT"
run "reboot required" bash -c "if [ -f /var/run/reboot-required ]; then cat /var/run/reboot-required*; else echo 'no reboot pending'; fi"
run "unattended"      bash -c "cat /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null | tail -30"
run "pending"         bash -c "apt list --upgradable 2>/dev/null | head -25"
[ -f /var/run/reboot-required ] && note "INFO  a reboot is pending (kernel/libc update). Confirm linger is enabled before rebooting, or Hermes will not come back up."

section "TIME"
run "timedatectl" timedatectl
run "sync"        bash -c "timedatectl show -p NTPSynchronized"
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "no" ]; then
  note "WARN  clock is not NTP-synchronised — cron fires at the wrong time and TLS handshakes can fail."
fi

# ---------------------------------------------------------------- network
section "NETWORK"
run "addresses"   ip -brief addr
run "routes"      ip route
run "listeners"   bash -c "ss -tulpn 2>/dev/null || netstat -tulpn"
run "conntrack"   bash -c "ss -s"
run "dns"         bash -c "cat /etc/resolv.conf; resolvectl status 2>/dev/null | head -20"
run "egress slack"    bash -c "curl -sS -o /dev/null -w 'slack.com %{http_code} in %{time_total}s\n' --max-time 10 https://slack.com/api/api.test"
run "egress deepseek" bash -c "curl -sS -o /dev/null -w 'api.deepseek.com %{http_code} in %{time_total}s\n' --max-time 10 https://api.deepseek.com"
run "egress github"   bash -c "curl -sS -o /dev/null -w 'github.com %{http_code} in %{time_total}s\n' --max-time 10 https://github.com"

section "FIREWALL / SSH"
run "ufw"       ufw status verbose
run "nftables"  bash -c "nft list ruleset 2>/dev/null | head -40"
run "fail2ban"  fail2ban-client status
run "sshd"      bash -c "grep -vE '^\s*#|^\s*$' /etc/ssh/sshd_config"
run "auth fails" bash -c "echo \"failed-password attempts in last 200 ssh log lines: \$(journalctl -u ssh -n 200 --no-pager 2>/dev/null | grep -ci 'failed password' || true)\""

if grep -qiE '^\s*PermitRootLogin\s+yes' /etc/ssh/sshd_config 2>/dev/null; then
  note "WARN  sshd permits root login with a password. Set PermitRootLogin prohibit-password and PasswordAuthentication no — this box has a public IP and will be scanned constantly."
fi
if ! have fail2ban-client && ! ufw status 2>/dev/null | grep -qi active; then
  note "INFO  neither fail2ban nor an active ufw ruleset detected on a public-IP host."
fi

# ---------------------------------------------------------------- containers
if have docker; then
  section "DOCKER"
  run "ps"     docker ps -a
  run "stats"  docker stats --no-stream
  run "disk"   docker system df
fi

# ---------------------------------------------------------------- summary
printf '\n\n===== FINDINGS =====\n'
printf 'hermes-diag %s on %s (user: %s)\n\n' "$TS" "$(hostname)" "$HERMES_USER"
if [ "${#FINDINGS[@]}" -eq 0 ]; then
  printf 'No automated findings. Nothing in the checked surfaces looks wrong —\n'
  printf 'if Hermes is still misbehaving, the gateway log section is the place to read.\n'
else
  printf '%s\n' "${FINDINGS[@]}" | sort -r
  printf '\n(CRIT = fix now, WARN = will bite soon, INFO = worth doing)\n'
fi

# Restore the real stdout before emitting anything to the terminal.
exec >&3 3>&-

if [ "$REDACT" -eq 1 ]; then
  sed -E -i \
    -e 's/\b([0-9]{1,3}\.){3}[0-9]{1,3}\b/<IP>/g' \
    -e 's/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/<EMAIL>/g' \
    -e 's/\bxox[baprs]-[A-Za-z0-9-]+/<SLACK_TOKEN>/g' \
    -e 's/\bxapp-[A-Za-z0-9-]+/<SLACK_APP_TOKEN>/g' \
    -e 's/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+/<GITHUB_TOKEN>/g' \
    -e 's/\bgithub_pat_[A-Za-z0-9_]+/<GITHUB_TOKEN>/g' \
    -e 's/\bsk-[A-Za-z0-9_-]{16,}/<API_KEY>/g' \
    -e 's/\b(AKIA|ASIA)[A-Z0-9]{16}\b/<AWS_KEY>/g' \
    -e 's/(Authorization:[[:space:]]*(Bearer|Basic)[[:space:]]*)[A-Za-z0-9._~+\/=-]+/\1<REDACTED>/gI' \
    -e 's/((password|passwd|secret|token|api_?key)[[:space:]]*[=:][[:space:]]*)[^[:space:]]+/\1<REDACTED>/gI' \
    "$OUT"
fi

cat "$OUT"

echo
echo "Full report: $OUT"
if [ "$REDACT" -eq 1 ]; then
  echo "(--redact applied: IPs, emails and token-shaped strings masked)"
else
  echo "NOTE: this report contains your public IP and may contain secrets from logs."
  echo "      Re-run with --redact before pasting it anywhere shared."
fi
