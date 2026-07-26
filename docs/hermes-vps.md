# Hermes VPS — architecture notes & diagnostic runbook

Reference notes for `hermes-falkenstein-2`, reconstructed from the Notion pages
under **Hermes Agent — Command Center**. The IP, tokens and keys deliberately
live in Notion, not here.

## What Hermes is

A self-hosted automation/agent harness — a Slack gateway plus a set of cron
scripts — that coordinates workflows across Notion, Make and assorted Node
scripts. It is **not** part of the haitian-community-cares site or content
pipeline; it is separate infrastructure that happens to be diagnosed from this
branch.

| | |
|---|---|
| Host | `hermes-falkenstein-2`, Hetzner CPX22, Ubuntu 24.04 (Falkenstein) |
| Hermes | v0.15.1 |
| Model | DeepSeek Chat, direct API |
| Gateway | Slack Socket Mode (outbound WSS — no inbound port required) |
| Process | systemd **user** service `hermes-gateway`, auto-restart + linger |
| Backup | daily cron 03:00 UTC → `github.com/aalikes/VPS-Hermes`, 7-day local retention |
| Cron | Node scripts under `~/scripts/`, logs appended to `~/logs/*.log` |
| Deploy | `~/Projects/hermes-agents`, `node hermes-deploy.mjs <Name> <xapp> <xoxb> <bot-id>` |

## Everyday commands

```bash
hermes gateway status                          # is it up
journalctl --user -u hermes-gateway -f         # follow logs
systemctl --user restart hermes-gateway        # restart
/root/hermes-backup.sh                         # manual backup
hermes import hermes-backup-latest.zip         # restore
```

## Runbook: diagnose, then decide

Follow these in order. The point of the sequence is that **step 1 makes
everything after it reversible**, and steps 2–3 tell you what is actually
wrong before you spend money or downtime fixing the wrong thing.

### 1. Snapshot first — from your Mac, not the VPS

```bash
export HCLOUD_TOKEN=...          # Hetzner Console > Security > API tokens (Read & Write)
./scripts/snapshot-hermes.sh
```

Bills on used disk, so this is cents a month. Equivalent to Console > Servers >
`hermes-falkenstein-2` > Snapshots > Take snapshot. Do not skip it: every later
step becomes safe once this exists.

### 2. Diagnose — on the VPS

```bash
./scripts/diagnose-hermes.sh --redact
```

Read-only. Run it **as the user that owns the `hermes-gateway` user unit**, not
under plain `sudo` — sudo reparents to root's own systemd user manager and makes
the service look missing. Output lands in `/tmp/hermes-diag-<timestamp>.txt` and
ends in a `FINDINGS` block ranked CRIT / WARN / INFO. `--summary` prints findings
only; `--redact` masks IPs, emails and token-shaped strings so the report is safe
to paste into a shared channel.

### 3. Verify the backup — on the VPS

```bash
./scripts/verify-hermes-backup.sh --extract
```

Checks archive freshness, zip integrity, expected contents, a real test
extraction, and — most importantly — whether the credential pushing to
`aalikes/VPS-Hermes` still authenticates. Exits non-zero if the backup cannot be
trusted.

**A backup you have never restored is a hypothesis, not a backup.** The failure
this is built to catch: the 3AM cron still runs and still writes an archive, but
the `git push` has been failing silently for weeks since a token expired. Local
commits pile up unpushed and nothing alerts. If this step fails, do not rebuild —
you would be destroying the only current copy.

### Shortcut: steps 2–3 in one command

```bash
./scripts/rescue-hermes.sh
```

Forces a fresh backup, verifies it, then runs diagnostics — in that order,
because if the 3AM cron has been failing silently the state on the box is the
only copy and must be captured before anything else. Bundles all output into
`/tmp/hermes-rescue-<ts>.tar.gz` for transfer, and exits non-zero if the backup
cannot be trusted. `--no-backup` skips the capture step.

Still take the snapshot (step 1) first.

### 4. Decide

With steps 2 and 3 done you know whether this is OOM, disk, a token, or billing.
Only now is "repair vs rebuild" an informed question.

### 5. Harden — on the VPS, as root

```bash
sudo ./scripts/harden-hermes.sh            # dry run, shows the plan
sudo ./scripts/harden-hermes.sh --apply    # commit the changes
sudo ./scripts/harden-hermes.sh --user X   # force a specific target user
```

**Check the second line of the output before applying.** It prints the user it
has decided Hermes runs as. This stack runs as root, so it should say
`user: root` — the script deliberately ignores `$SUDO_USER`, because sudo-ing
from a personal login would otherwise point the logrotate rule at the wrong
home and enable linger for the wrong account, fixing nothing while reporting
success. If the detected user looks wrong, override it with `--user`.

Fixes the four known config gaps: adds a 2GB swapfile, installs a logrotate rule
for `~/logs/*.log`, enables linger, and caps journald. Idempotent — running it
twice is a no-op. This is the one script here that changes the system, which is
why it is dry-run by default.

Afterwards, **prove linger by actually rebooting** and confirming
`hermes-gateway` returns on its own. Do that while watching, not at 3AM on a
Friday.

### If you do rebuild

Build the new server **alongside** the old one and cut over — never rebuild in
place. Hetzner bills hourly, so a few days of overlap costs about a euro and
leaves you a working fallback the entire time. Carry the step-5 fixes into the
new build from the start, wire up the Notion MCP provider (see below), and put
the whole thing in a committed script so the next rebuild is twenty minutes
rather than a day.

Run it **as the user that owns the `hermes-gateway` user unit** — not under
plain `sudo`, which reparents to root's own systemd user manager and makes the
service look missing. The script is read-only: it never restarts, edits,
installs or deletes anything.

Output goes to `/tmp/hermes-diag-<timestamp>.txt` and ends in a `FINDINGS`
block ranked CRIT / WARN / INFO.

## Changing these scripts

```bash
./scripts/test-hermes-tools.sh
```

32 checks covering syntax, shellcheck (warning and info), flag handling, and
the behaviours that matter: that `--redact` actually masks, that dry runs
mutate nothing, that `harden` targets root rather than `$SUDO_USER`, that
`verify` and `rescue` exit non-zero when a backup cannot be trusted, and that
the retention count does not double when `$HOME` is `/root`. Run it after any
edit.

## Failure modes it checks for

These are the ways this particular stack tends to break, roughly in order of
likelihood:

1. **OOM kill.** 4GB with no swap, running Node. The kernel OOM killer taking
   out the gateway is the most likely cause of a silently dead Hermes. A 2GB
   swapfile is cheap insurance.
2. **Unrotated logs filling the disk.** The cron scripts append to
   `~/logs/*.log` with `>>` and there is no `logrotate.d` rule for them, so
   they grow without bound.
3. **Linger disabled.** Without `loginctl enable-linger`, a user unit dies at
   logout and does not return after reboot. Worth confirming before any reboot.
4. **Slack token expiry / revocation.** Shows up as `invalid_auth` or
   `token_revoked` in the gateway log, or as a Socket Mode reconnect storm.
5. **DeepSeek key or balance.** Hermes calls the API directly, so a billing
   lapse presents exactly like a dead agent.
6. **Backup cron failing silently.** Usually an expired PAT or deploy key — the
   cron still runs, the `git push` just stops working. The script flags a
   newest-commit age over 48h.
7. **Crash-looping gateway.** `NRestarts` climbing means auto-restart is
   masking a real error rather than fixing it.
8. **Disk I/O errors / clock drift / pending reboots.**

## Open loop: the Notion write path

The Activity Tracker records **"Connect Notion MCP Provider" — Status: Not
started**, and the VPS Task Queue instructs agents to "poll this page daily" and
update the Shaka Kanban board. No agent-side writes appear in either; the task
queue's own footer credits its last update to Shaka (the Mac), not to an agent.

The Activity Tracker also has no entries after 2026-06-05.

Do not read that silence as proof Hermes is down — if the Notion write path was
never connected, silence is exactly what a perfectly healthy Hermes would
produce. But it does mean the loop is open independently of the box's health:
**Hermes cannot pull work from the queue it is documented to pull from.** Worth
closing whether you repair or rebuild.

A related data point for the egress checks in `diagnose-hermes.sh`: a 2026-05-25
entry reads *"Web searches blocked from cloud server — OSM used as fallback."*
Outbound HTTP from this VPS was already restricted two months ago, which is why
the diagnostics probe Slack, DeepSeek and GitHub reachability separately.
