#!/usr/bin/env bash
# 宿主侧更新执行器：由 systemd path 单元在容器之外调用，跑完 scripts/update.sh 的安全重建。
#
# 应用只做两件事：git pull，然后往 data/update-wake/ 落一个 request.json。
# 这里负责：备份数据库 → 构建镜像 → 重建容器 → 健康检查 → 失败回滚（全部在 update.sh 里），
# 并把过程写进 data/update-status.json 与 data/update.log，供「更新管理」页面轮询显示。
#
# 放在宿主机执行的原因：docker compose up -d 会重建应用容器，容器里的进程会跟着被杀掉。
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${CIKE_DATA_DIR:-$ROOT/data}"
WAKE_DIR="$DATA_DIR/update-wake"
STATUS="$DATA_DIR/update-status.json"
LOG="$DATA_DIR/update.log"
LOCK="${CIKE_UPDATE_LOCK:-/var/lock/cike-update.lock}"

mkdir -p "$DATA_DIR" || exit 1

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

# 单实例：上一轮还没结束就不叠加第二轮
exec 9>"$LOCK" || exit 0
if ! flock -n 9; then
  log "update_dispatch: 上一轮重建还在进行，跳过本次触发"
  exit 0
fi

json_get() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    data = {}
value = data.get(sys.argv[2], "") if isinstance(data, dict) else ""
print(value if isinstance(value, (str, int, float)) else "")
PY
}

head_commit() { git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown; }

from_commit=""
to_commit=""
trigger="web"
requested_at=""
if [ -f "$WAKE_DIR/request.json" ]; then
  from_commit="$(json_get "$WAKE_DIR/request.json" from)"
  to_commit="$(json_get "$WAKE_DIR/request.json" to)"
  trigger="$(json_get "$WAKE_DIR/request.json" trigger)"
  requested_at="$(json_get "$WAKE_DIR/request.json" requested_at)"
fi
rm -rf "$WAKE_DIR"

trigger="${trigger:-web}"
to_commit="${to_commit:-$(head_commit)}"
started_at="$(date -Is)"
requested_at="${requested_at:-$started_at}"
start_seconds=$SECONDS

write_status() { # write_status <state> <error> <duration|null>
  local state="$1" error="${2:-}" duration="${3:-null}"
  printf '{"state":"%s","from":"%s","to":"%s","trigger":"%s","requested_at":"%s","started_at":"%s","finished_at":"%s","duration_s":%s,"error":"%s"}\n' \
    "$state" "$from_commit" "$to_commit" "$trigger" "$requested_at" "$started_at" "$(date -Is)" "$duration" "$error" >"$STATUS.tmp"
  mv -f "$STATUS.tmp" "$STATUS"
}

: >"$LOG"
log "update_dispatch: 开始安全重建（$from_commit → $to_commit，trigger=$trigger）"
write_status running "" "null"

if bash "$ROOT/scripts/update.sh" >>"$LOG" 2>&1; then
  to_commit="$(head_commit)"
  duration=$((SECONDS - start_seconds))
  write_status success "" "$duration"
  log "update_dispatch: 重建完成，运行版本 $to_commit（${duration}s）"
  exit 0
fi

duration=$((SECONDS - start_seconds))
reason="$(awk '/update_failed/{value=$2} END{print value}' "$LOG" 2>/dev/null)"
reason="${reason:-update_failed}"
write_status failed "$reason" "$duration"
log "update_dispatch: 重建失败（${duration}s，$reason），update.sh 已按自身流程回滚上一镜像"
exit 1
