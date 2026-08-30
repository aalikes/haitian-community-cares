# Notes App Disk Reclaim — VPS Runbook

A measure-first procedure for shrinking a self-hosted notes app on a VPS. Every
destructive step is gated behind a measurement that proves it will help and a backup
that makes it reversible. Work the phases in order — the ordering is the safety
mechanism, not a formality.

- **Run as:** a user with sudo
- **Expect:** 30–90 minutes
- **Downtime:** phases 03 and 04 only

Command blocks are tagged by risk:

| Tag | Meaning |
| --- | --- |
| `READ` | Read-only. Changes nothing. |
| `GATE` | A precondition that must pass before the next step. |
| `WRITE` | Mutates data. Treat as irreversible. |

---

## Phase 00 — Baseline and backup

Before touching anything, answer one question: **is this a full disk on the VPS, or an
app that has grown slow and unwieldy?** They look identical from the outside and have
completely different fixes.

**`READ`** — disk and inode pressure:

```bash
df -h
df -i
free -h
uptime
```

> **Reading the output:** if `df -h` shows plenty free but the app still errors on write,
> check `df -i`. **Inode exhaustion** presents as a full disk with gigabytes available, and
> is usually millions of tiny files (cache chunks, session files), not one big database.

Now get a backup. Nothing below this line runs until you have one. The cheapest and most
complete option is a provider-level snapshot from your VPS control panel — take it now,
note the snapshot ID, and continue.

**`GATE`** — application-level backup (adjust paths after phase 02):

```bash
# Stop writes first so the copy is consistent
sudo systemctl stop <notes-service>      # or: docker compose stop

sudo tar -czf /root/notes-backup-$(date +%F).tar.gz \
  /path/to/notes/data /path/to/notes/config

ls -lh /root/notes-backup-*.tar.gz
sudo systemctl start <notes-service>
```

> **Do not skip.** A backup stored only on the VPS you are about to clean is not a backup.
> Copy it off the box — `scp`, `rclone`, object storage, anything — before proceeding.
> Several steps in phase 03 are irreversible by design.

---

## Phase 01 — Find where the bytes actually are

Descend the filesystem largest-first. `-x` keeps the walk on one filesystem so bind mounts
and network shares don't distort the picture.

**`READ`**:

```bash
sudo du -x -h -d1 / 2>/dev/null | sort -rh | head -20
sudo du -x -h -d1 /var 2>/dev/null | sort -rh | head -20
sudo du -x -h -d1 /opt /home /srv 2>/dev/null | sort -rh | head -20

# Largest individual files anywhere on the root filesystem
sudo find / -xdev -type f -size +200M -printf '%10s  %p\n' 2>/dev/null | sort -rn | head -20
```

> **Expect a surprise here.** On most VPS boxes running a containerised notes app, the notes
> data is *not* the biggest consumer. Uncapped Docker container logs, the systemd journal,
> and a pile of old backups routinely outweigh the database several times over. Phase 04
> handles those, and it is often where the real gigabytes come from.

### The two failures that hide from `du`

`du` walks the directory tree, so it misses space that has no path. Both of these are
common and both look like "the disk is full for no reason."

**`READ`** — deleted files still held open by a running process:

```bash
sudo lsof -nP +L1 2>/dev/null | awk 'NR==1 || $5=="REG"' | head -25
```

A log rotated out from under a process that still holds the file descriptor keeps its
blocks allocated until that process restarts. If the list shows a multi-gigabyte entry,
restarting the owning service reclaims it instantly — no deletion needed.

**`READ`** — files hidden underneath an active mountpoint:

```bash
sudo mkdir -p /mnt/rootcheck
sudo mount --bind / /mnt/rootcheck
sudo du -x -h -d2 /mnt/rootcheck 2>/dev/null | sort -rh | head -20
sudo umount /mnt/rootcheck
```

If something was written to a directory *before* a volume was mounted over it, the data is
still on the underlying disk and invisible to a normal walk. The bind mount exposes it.

---

## Phase 02 — Identify the app and its storage engine

The cleanup in phase 03 branches on the storage engine, so pin it down precisely.

**`READ`**:

```bash
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker volume ls

systemctl list-units --type=service --state=running \
  | grep -iE 'couch|joplin|postgres|mysql|maria|trilium|siyuan|memos|note|standard'

sudo ss -tlnp

docker compose config 2>/dev/null | head -60   # from the compose directory
```

| If you see | Engine | Go to |
| --- | --- | --- |
| couchdb, port 5984 | CouchDB — Obsidian LiveSync | `03-A` |
| joplin/server, postgres | PostgreSQL | `03-B` |
| trilium, siyuan, memos | SQLite + attachment dir | `03-C` |
| standardnotes, notesnook | MySQL/Postgres + uploads | `03-B`, then `03-D` |
| A plain synced directory | Filesystem only | `03-D` |

> **Likely candidate.** The repo README notes that source material is backed up in Obsidian.
> If the VPS is syncing that vault, this is almost certainly **CouchDB running Obsidian
> LiveSync** — also the most bloat-prone option on the list, for the structural reasons in
> `03-A`. Confirm before acting on it.

---

## Phase 03 — Shrink the notes store

Run only the branch that matches phase 02, then continue to `03-D`.

### 03-A · CouchDB — Obsidian LiveSync

**Why it bloats.** LiveSync splits every note into content-addressed chunks and writes a
new revision on every edit. CouchDB retains revision metadata up to `_revs_limit`
(default **1000**), deleted documents leave permanent tombstones, and superseded chunks are
never garbage-collected by the plugin. The `.couch` file is append-only — it grows forever
until you compact it.

**`READ`** — measure the reclaimable fraction:

```bash
export CU=admin CP='your-password'          # avoid a leading space in shell history

curl -sS -u "$CU:$CP" http://127.0.0.1:5984/_all_dbs

# Substitute your database name for <db>
curl -sS -u "$CU:$CP" http://127.0.0.1:5984/<db> | python3 -m json.tool
```

> **The number that matters.** Compare `sizes.file` against `sizes.active`. `active` is the
> live data; `file` is what's on disk. A database showing 8 GB file against 900 MB active
> will give back roughly **7 GB** on compaction. If the two are close, compaction is not your
> problem — skip to phase 04.

**`GATE`** — compaction needs free space ≈ the active size:

```bash
df -h /opt/couchdb/data     # or wherever the .couch files live
sudo du -sh /opt/couchdb/data/*.couch
```

Lower the revision limit *before* compacting, so the compaction pass actually discards the
old revisions rather than faithfully copying them across.

**`WRITE`**:

```bash
# 100 is a sane LiveSync value; the default of 1000 is the bloat driver
curl -sS -X PUT -u "$CU:$CP" \
  http://127.0.0.1:5984/<db>/_revs_limit -d '100'

curl -sS -X POST -u "$CU:$CP" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:5984/<db>/_compact

curl -sS -X POST -u "$CU:$CP" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:5984/<db>/_view_cleanup

# Watch it run; the database stays readable throughout
watch -n5 "curl -sS -u \"$CU:$CP\" http://127.0.0.1:5984/_active_tasks | python3 -m json.tool"
```

> **Trade-off.** A lower `_revs_limit` shrinks the headroom LiveSync has to resolve sync
> conflicts across devices. 100 is comfortable. Going to 10 saves little extra and makes
> conflicts on a rarely-synced device harder to merge cleanly.

Re-run the size check. If `file` is still far above `active` after compaction completes, the
remaining bulk is orphaned chunks from deleted or rewritten notes — LiveSync's own
**Rebuild everything** is the supported fix.

> **Irreversible.** *Rebuild everything* discards the entire remote database and repopulates
> it from one device's local vault. It is the correct tool and it works — but every other
> device must then re-sync from scratch, and any note that exists *only* on another device is
> lost. Before running it: confirm the vault on your chosen source device is complete, and
> confirm your phase 00 backup is off-box.

### 03-B · PostgreSQL — Joplin Server, Standard Notes

**Why it bloats.** Attachments are stored as `bytea` in the items table, change-tracking
tables accumulate one row per sync event forever, and Postgres leaves dead tuples behind on
every update that plain autovacuum marks reusable but never returns to the OS.

**`READ`** — rank tables by real size, and check dead-tuple load:

```bash
sudo -u postgres psql -d joplin -c "
SELECT relname AS table,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       n_live_tup AS live, n_dead_tup AS dead
FROM pg_class c
JOIN pg_stat_user_tables s ON s.relid = c.oid
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 20;"
```

High `dead` relative to `live` means bloat that a routine vacuum will not hand back. Clear
the retained change log first, then reclaim.

**`WRITE`** — trim change history (inspect the count before deleting):

```bash
sudo -u postgres psql -d joplin -c \
  "SELECT count(*) FROM changes WHERE created_time < extract(epoch from now() - interval '90 days')*1000;"

sudo -u postgres psql -d joplin -c \
  "DELETE FROM changes WHERE created_time < extract(epoch from now() - interval '90 days')*1000;"
```

**`WRITE`** — reclaim to the OS:

```bash
sudo -u postgres psql -d joplin -c "VACUUM (VERBOSE, ANALYZE);"

# Only if dead tuples remain high after the above:
sudo -u postgres psql -d joplin -c "VACUUM FULL VERBOSE;"
```

> **`VACUUM FULL` blocks everything.** It rewrites each table into a new file, so it needs
> free space roughly equal to the largest table's size and holds an `ACCESS EXCLUSIVE` lock
> for the duration. The app is down while it runs. Schedule it, don't fire it mid-day.

**`READ`** — if `pg_wal` is the large directory, it is one of these two:

```bash
sudo du -sh /var/lib/postgresql/*/main/pg_wal
sudo -u postgres psql -c "SELECT slot_name, active, restart_lsn FROM pg_replication_slots;"
sudo -u postgres psql -c "SHOW archive_mode; SHOW archive_command;"
```

An **inactive replication slot** pins WAL indefinitely and will fill the disk on its own. If
a slot shows `active = f` and nothing is meant to be replicating, drop it with
`pg_drop_replication_slot('name')`. A failing `archive_command` has the same effect — fix the
command or disable archiving.

### 03-C · SQLite — Trilium, SiYuan, Memos

**Why it bloats.** These keep a full revision row per note edit, and SQLite never returns
freed pages to the filesystem without an explicit `VACUUM`. A `-wal` file that never shrinks
means checkpointing is not completing.

**`READ`** — free pages and per-table bytes:

```bash
DB=/path/to/document.db

ls -lh "$DB" "$DB-wal" "$DB-shm" 2>/dev/null
sqlite3 "$DB" "PRAGMA page_count; PRAGMA page_size; PRAGMA freelist_count;"

sqlite3 "$DB" "
SELECT name, SUM(pgsize) AS bytes
FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 20;"
```

`freelist_count × page_size` is what a `VACUUM` returns immediately. If the revision or blob
tables dominate, trim them first so the vacuum has more to reclaim.

**`GATE`** — stop the app; vacuuming a live database risks corruption:

```bash
sudo systemctl stop trilium        # or: docker compose stop
sqlite3 "$DB" "PRAGMA integrity_check;"
```

**`WRITE`** — trim revisions older than 90 days, then compact:

```bash
# Count first — confirm the number looks right before deleting
sqlite3 "$DB" "SELECT count(*) FROM revisions
  WHERE utcDateCreated < datetime('now','-90 days');"

sqlite3 "$DB" "DELETE FROM revisions
  WHERE utcDateCreated < datetime('now','-90 days');"

# Drop blobs no longer referenced by any note or revision
sqlite3 "$DB" "DELETE FROM blobs WHERE blobId NOT IN (
  SELECT blobId FROM notes     WHERE blobId IS NOT NULL
  UNION SELECT blobId FROM revisions WHERE blobId IS NOT NULL);"

sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"
ls -lh "$DB"
sudo systemctl start trilium
```

> **Schema varies by version.** Table and column names differ across Trilium, SiYuan and
> Memos releases. Confirm yours with `sqlite3 "$DB" ".tables"` and `.schema revisions` before
> running the deletes. `VACUUM` also needs free space roughly equal to the database size.

### 03-D · Orphaned attachments — all engines

Attachment files routinely outlive the notes that referenced them. Build a manifest and
review it before a single byte is deleted.

**`READ`**:

```bash
ATT=/path/to/attachments

sudo du -sh "$ATT"
sudo find "$ATT" -type f -printf '%10s  %p\n' | sort -rn | head -30
sudo find "$ATT" -type f | wc -l
sudo find "$ATT" -type f -atime +365 | wc -l
```

**`GATE`** — write candidates to a manifest, then read it:

```bash
# Every filename referenced anywhere in the database
sqlite3 "$DB" "SELECT filename FROM attachments;" | sort -u > /tmp/referenced.txt

# Everything actually on disk
sudo find "$ATT" -type f -printf '%f\n' | sort -u > /tmp/on-disk.txt

comm -23 /tmp/on-disk.txt /tmp/referenced.txt > /tmp/orphans.txt
wc -l /tmp/orphans.txt
head -40 /tmp/orphans.txt
```

> **Move, don't delete.** Relocate orphans to a holding directory and leave them for a week.
> If nothing breaks, delete the directory. A reference the query didn't know about — an
> embed, a template, an export — only reveals itself in use.

```bash
sudo mkdir -p /root/orphan-quarantine
while read -r f; do
  sudo find "$ATT" -name "$f" -exec mv -t /root/orphan-quarantine {} +
done < /tmp/orphans.txt
sudo du -sh /root/orphan-quarantine
```

---

## Phase 04 — Reclaim the host

Frequently the largest single win, and none of it touches your notes.

### Docker

**`READ`** — measure before pruning:

```bash
docker system df -v

# Container logs: the most common uncapped growth on a Docker host
sudo du -ch /var/lib/docker/containers/*/*-json.log 2>/dev/null | sort -rh | head
```

**`WRITE`** — safe prune, images and build cache only:

```bash
docker image prune -a --filter "until=168h"
docker builder prune --filter "until=168h"
docker container prune --filter "until=168h"
```

> **Never run this blind.** `docker system prune -a --volumes` deletes **named volumes not
> attached to a running container** — which on a stopped stack includes the volume holding
> your notes database. If your app is stopped for phase 03 when you run it, you will delete
> the data you came here to protect.
>
> If you need volume cleanup, list them and remove them by name after checking each one:
> `docker volume ls`, then `docker volume inspect <name>`.

Truncating a live container log is safe; deleting the file is not, because the daemon keeps
writing to the open descriptor.

**`WRITE`**:

```bash
sudo sh -c 'for f in /var/lib/docker/containers/*/*-json.log; do : > "$f"; done'
```

### systemd journal

**`WRITE`** — defaults to 10% of the disk, usually far more than needed:

```bash
journalctl --disk-usage
sudo journalctl --vacuum-size=200M
sudo journalctl --vacuum-time=14d
```

### Packages and kernels

**`WRITE`** — old kernels on a small `/boot` are often gigabytes:

```bash
sudo apt-get clean
sudo apt-get autoremove --purge
df -h /boot
```

### Stale backups

**`GATE`** — list and read before removing anything:

```bash
sudo find / -xdev \( -name '*.tar.gz' -o -name '*.sql' -o -name '*.dump' -o -name '*.bak' \) \
  -size +50M -printf '%TY-%Tm-%Td %10s  %p\n' 2>/dev/null | sort -r | head -30
```

Keep today's backup from phase 00. Anything older that already lives off-box is a candidate —
but confirm the off-box copy exists before deleting the local one.

---

## Phase 05 — Prevent recurrence

Everything above is a one-time reclaim. Without these four changes you will be back here in
a few months.

### Cap container logs permanently

**`WRITE`** — `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

> **Applies to new containers only.** After `sudo systemctl restart docker`, existing
> containers keep their old uncapped setting. They must be recreated —
> `docker compose up -d --force-recreate` — for the cap to take effect.

### Bound the journal

**`WRITE`** — `/etc/systemd/journald.conf`, then restart `systemd-journald`:

```ini
[Journal]
SystemMaxUse=200M
MaxRetentionSec=1month
```

### Schedule CouchDB compaction (03-A only)

**`WRITE`** — `local.ini`; compacts overnight once fragmentation passes 50%:

```ini
[compactions]
_default = [{db_fragmentation, "50%"}, {view_fragmentation, "50%"}, {from, "23:00"}, {to, "05:00"}]
```

This is the single highest-value change in the runbook for a LiveSync setup. It turns
compaction from something you remember to do into something that happens.

### Alert before it's urgent

**`WRITE`** — daily check at 08:00 via `sudo crontab -e`:

```cron
0 8 * * * df -h / | awk 'NR==2 && int($5) > 80 {print "VPS disk at " $5}' | \
  mail -s "VPS disk warning" you@example.com
```

> **Close the loop.** Restore your phase 00 backup somewhere disposable and open a note from
> it. A backup you have never restored is a hypothesis, and this is the moment you have one
> to test.

---

## What to send back for a targeted pass

This runbook is deliberately general because the VPS was not reachable from the session that
wrote it. These five read-only commands are enough to replace the branching with exact
commands and real numbers:

```bash
df -h; df -i
sudo du -x -h -d1 / 2>/dev/null | sort -rh | head -20
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker system df -v
journalctl --disk-usage
```

---

*Written without access to the target host. Every command is standard for its engine, but
paths, database names, and table schemas vary by version and install method. Confirm each
against your system before running it, and treat the `WRITE` blocks as irreversible.*
