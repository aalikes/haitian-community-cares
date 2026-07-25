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

## Diagnostics

```bash
./scripts/diagnose-hermes.sh            # full report
./scripts/diagnose-hermes.sh --redact   # mask IPs/emails/tokens before sharing
./scripts/diagnose-hermes.sh --summary  # findings only
```

Run it **as the user that owns the `hermes-gateway` user unit** — not under
plain `sudo`, which reparents to root's own systemd user manager and makes the
service look missing. The script is read-only: it never restarts, edits,
installs or deletes anything.

Output goes to `/tmp/hermes-diag-<timestamp>.txt` and ends in a `FINDINGS`
block ranked CRIT / WARN / INFO.

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
