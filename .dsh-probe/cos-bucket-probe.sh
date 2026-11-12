#!/usr/bin/env bash
# Read/write/rename probe for the cosfs backup mount on the target Linux host.
# Writes only under a hidden .dsh-probe-* directory and removes it afterwards.
set -u
MOUNT=${MOUNT:-/cos-backup}
BASE="$MOUNT/.dsh-probe-$(date +%s)"
now_ms() { date +%s%3N; }
ms_between() { echo $(( $2 - $1 )); }
json() { printf '%s\n' "$1"; }

if ! mountpoint -q "$MOUNT"; then
  echo "MOUNT_MISSING"
  exit 2
fi

mkdir -p "$BASE/point/journal" "$BASE/x" || { echo "MKDIR_FAILED"; exit 3; }

# 1. list latency
t0=$(now_ms); ls "$MOUNT" >/dev/null 2>&1; t1=$(now_ms)
list_ms=$(ms_between "$t0" "$t1")

# 2. write 70 small files (backup-like object count)
t0=$(now_ms)
for i in $(seq 1 70); do head -c 4096 /dev/urandom > "$BASE/point/journal/f$i.bin"; done
t1=$(now_ms)
write70_ms=$(ms_between "$t0" "$t1")

t0=$(now_ms); sync; t1=$(now_ms); sync_ms=$(ms_between "$t0" "$t1")

# 3. sample digest before read-back
digest=$(sha256sum "$BASE/point/journal/f1.bin" "$BASE/point/journal/f70.bin" | sha256sum | cut -d' ' -f1)

# 4. drop cache (best effort) then read all 70
sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null || true
t0=$(now_ms)
for f in "$BASE"/point/journal/*.bin; do cat "$f" > /dev/null; done
t1=$(now_ms)
read70_ms=$(ms_between "$t0" "$t1")
digest_after=$(sha256sum "$BASE/point/journal/f1.bin" "$BASE/point/journal/f70.bin" | sha256sum | cut -d' ' -f1)

# 5. 20 MiB single object write + flush + read
t0=$(now_ms); dd if=/dev/urandom of="$BASE/big.bin" bs=1M count=20 status=none; t1=$(now_ms); write20_ms=$(ms_between "$t0" "$t1")
t0=$(now_ms); sync; t1=$(now_ms); flush20_ms=$(ms_between "$t0" "$t1")
t0=$(now_ms); dd if="$BASE/big.bin" of=/dev/null bs=1M status=none; t1=$(now_ms); read20_ms=$(ms_between "$t0" "$t1")

# 6. directory rename across parents (backup publish path: .tmp/backupId -> backups/backupId)
t0=$(now_ms); mv "$BASE/point" "$BASE/point2" 2>/tmp/.dsh-probe-rename.err; rc=$?; t1=$(now_ms)
rename_ms=$(ms_between "$t0" "$t1")
rename_ok=$([ "$rc" -eq 0 ] && [ -f "$BASE/point2/journal/f70.bin" ] && echo true || echo false)

# 7. atomic replace (atomicWriteFile path)
atomic_ok=$(python3 - "$BASE" <<'PY'
import os, sys
base = sys.argv[1]
tmp = os.path.join(base, 'replace.tmp')
dst = os.path.join(base, 'replace.final')
with open(tmp, 'w') as fh:
    fh.write('ok')
try:
    os.replace(tmp, dst)
    print('true' if open(dst).read() == 'ok' else 'false')
except Exception:
    print('false')
PY
)

# 8. cleanup and confirm
t0=$(now_ms); rm -rf "$BASE"; t1=$(now_ms); cleanup_ms=$(ms_between "$t0" "$t1")
leftover=$(ls -d "$MOUNT"/.dsh-probe-* 2>/dev/null | wc -l)

uid_name=$(id -un)
host=$(hostname)
mount_line=$(mount | grep -F " $MOUNT " | head -1)
mounted_source=$(echo "$mount_line" | awk '{print $1}')

json "$(printf '{"host":"%s","user":"%s","mount":"%s","source":"%s","listMs":%s,"write70FilesMs":%s,"syncMs":%s,"read70FilesMs":%s,"write20MiBMs":%s,"flush20MiBMs":%s,"read20MiBMs":%s,"renameDirMs":%s,"renameDirOk":%s,"atomicReplaceOk":%s,"cleanupMs":%s,"leftoverProbeDirs":%s,"digestMatch":%s}' \
  "$host" "$uid_name" "$MOUNT" "$mounted_source" "$list_ms" "$write70_ms" "$sync_ms" "$read70_ms" "$write20_ms" "$flush20_ms" "$read20_ms" "$rename_ms" "$rename_ok" "$atomic_ok" "$cleanup_ms" "$leftover" "$([ "$digest" = "$digest_after" ] && echo true || echo false)")"
