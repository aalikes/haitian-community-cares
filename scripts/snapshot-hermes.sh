#!/usr/bin/env bash
# snapshot-hermes.sh — take a Hetzner Cloud snapshot of the Hermes VPS before
# touching anything else. Step 1 of the runbook in docs/hermes-vps.md.
#
# Snapshots are non-destructive and bill on *used* disk, so this is cents a
# month. It makes every later step reversible.
#
# Run this from anywhere with network access (your Mac is fine) — it talks to
# the Hetzner API, not to the server.
#
#   export HCLOUD_TOKEN=...            # Hetzner Cloud console > Security > API tokens
#   ./scripts/snapshot-hermes.sh                       # snapshot hermes-falkenstein-2
#   ./scripts/snapshot-hermes.sh --server my-other-vps
#   ./scripts/snapshot-hermes.sh --list                # list existing snapshots, take none
#
# The token needs Read & Write. It is never printed or written to disk by this
# script.

set -uo pipefail

SERVER_NAME="hermes-falkenstein-2"
LIST_ONLY=0
API="https://api.hetzner.cloud/v1"

while [ $# -gt 0 ]; do
  case "$1" in
    --server)
      # `shift 2` with only one arg left is a no-op that loops forever.
      [ $# -ge 2 ] || { echo "--server needs a value" >&2; exit 2; }
      SERVER_NAME="$2"; shift 2 ;;
    --list)   LIST_ONLY=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "${HCLOUD_TOKEN:-}" ]; then
  cat >&2 <<'EOF'
HCLOUD_TOKEN is not set.

Create one at: Hetzner Cloud Console > your project > Security > API tokens
Permission required: Read & Write

Then:  export HCLOUD_TOKEN=<token>

Prefer clicking? Console > Servers > hermes-falkenstein-2 > Snapshots > Take
snapshot does exactly the same thing.
EOF
  exit 1
fi

# jq if available, else python3. One of the two is almost always present.
if command -v jq >/dev/null 2>&1; then
  json() { jq -r "$1"; }
elif command -v python3 >/dev/null 2>&1; then
  # translate a tiny subset of jq paths into python
  json() { python3 -c '
import json,sys
path=sys.argv[1].lstrip(".")
d=json.load(sys.stdin)
for part in path.split("."):
    if not part: continue
    if "[" in part:
        k,i=part.rstrip("]").split("[")
        d=d.get(k) or []
        d=d[int(i)] if len(d)>int(i) else None
    else:
        d=d.get(part) if isinstance(d,dict) else None
    if d is None: break
print("" if d is None else d)' "$1"; }
else
  echo "need jq or python3 to parse the API response" >&2
  exit 1
fi

# Keep the token out of the command line: curl's argv is world-readable via
# /proc/<pid>/cmdline for as long as the request runs. -H @file reads headers
# from a 0600 file instead.
HDR_FILE="$(mktemp)"
chmod 600 "$HDR_FILE"
trap 'rm -f "$HDR_FILE"' EXIT INT TERM
printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$HCLOUD_TOKEN" > "$HDR_FILE"

api() {
  local method="$1" path="$2"; shift 2
  curl -sS -X "$method" -H @"$HDR_FILE" "$@" "${API}${path}"
}

# --------------------------------------------------------------- list mode
if [ "$LIST_ONLY" -eq 1 ]; then
  echo "Existing snapshots:"
  api GET "/images?type=snapshot&sort=created:desc" \
    | { command -v jq >/dev/null 2>&1 \
        && jq -r '.images[] | "  \(.created)  \(.image_size // "?")GB  \(.description)"' \
        || cat; }
  exit 0
fi

# --------------------------------------------------------------- find server
echo "Looking up server '${SERVER_NAME}'..."
RESP="$(api GET "/servers?name=${SERVER_NAME}")"

if echo "$RESP" | grep -q '"error"'; then
  echo "API error:" >&2
  echo "$RESP" | head -20 >&2
  echo >&2
  echo "A 401 here means the token is wrong or revoked; 403 means it is read-only." >&2
  exit 1
fi

SERVER_ID="$(printf '%s' "$RESP" | json '.servers[0].id')"
SERVER_STATUS="$(printf '%s' "$RESP" | json '.servers[0].status')"

if [ -z "$SERVER_ID" ]; then
  echo "No server named '${SERVER_NAME}' in this project." >&2
  echo "Check the name in the Hetzner console, or pass --server <name>." >&2
  echo "(If the token belongs to a different project, it will not see this server.)" >&2
  exit 1
fi

echo "Found server id ${SERVER_ID}, status: ${SERVER_STATUS}"
echo

# A running server can be snapshotted, but the image is crash-consistent —
# fine for config and logs, not for a database mid-write. Hermes keeps state in
# files, so this is acceptable; just be aware of what you are getting.
if [ "$SERVER_STATUS" = "running" ]; then
  echo "NOTE: the server is running, so this snapshot is crash-consistent —"
  echo "      equivalent to pulling the power cord. Fine for Hermes (file state),"
  echo "      and it avoids downtime. Power off first if you want a clean image."
  echo
fi

DESC="hermes-pre-diagnosis-$(date -u +%Y%m%dT%H%M%SZ)"
echo "Creating snapshot: ${DESC}"

CREATE="$(api POST "/servers/${SERVER_ID}/actions/create_image" \
  -d "{\"description\":\"${DESC}\",\"type\":\"snapshot\"}")"

if echo "$CREATE" | grep -q '"error"'; then
  echo "Snapshot request failed:" >&2
  echo "$CREATE" | head -20 >&2
  exit 1
fi

ACTION_ID="$(printf '%s' "$CREATE" | json '.action.id')"
IMAGE_ID="$(printf '%s' "$CREATE" | json '.image.id')"
echo "Snapshot started (action ${ACTION_ID}, image ${IMAGE_ID}). Waiting..."

# ------------------------------------------------------------------- poll
for _ in $(seq 1 120); do
  sleep 10
  STATUS="$(api GET "/actions/${ACTION_ID}" | json '.action.status')"
  case "$STATUS" in
    success)
      echo
      echo "SNAPSHOT COMPLETE"
      echo "  description: ${DESC}"
      echo "  image id:    ${IMAGE_ID}"
      echo
      echo "You can now run the diagnostics safely. To restore later:"
      echo "  Console > Servers > ${SERVER_NAME} > Rebuild, and pick this snapshot,"
      echo "  or create a new server from image ${IMAGE_ID} to build alongside."
      exit 0 ;;
    error)
      echo "Snapshot FAILED. Check the console for details." >&2
      exit 1 ;;
    running|*)
      printf '.' ;;
  esac
done

echo
echo "Still running after 20 minutes — large disks can take a while."
echo "Check progress: Console > Images > Snapshots, or re-run with --list."
