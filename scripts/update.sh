#!/usr/bin/env bash
# cike 生产更新：拉取 → 备份 PostgreSQL → 构建镜像 → 重建容器 → 健康检查 → 失败回滚。
#
# 与 vgs / shifen 的 scripts/update.sh 同构，两处刻意的差异：
#
#   1. cike 的代码是**烘焙进镜像**的（`./` 挂在容器 `/repo`，跑的是镜像内 `/app`），
#      改文件不等于改运行中的服务 —— 必须 build。这一点与另外三个站不同。
#
#   2. 回滚**不动 git 工作树**（不执行 `git reset --hard`）。
#      原因：本地可能有不属于上游的改动，静默 reset 会把它们一起丢掉，
#      而且脚本失败时你往往正需要看现场。所以回滚只退「镜像 + 数据库」，
#      代码状态由 `git_state_hint` 打印出来，交给人判断。
#
# 用法：bash scripts/update.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICE="cike"
CONTAINER="${CIKE_CONTAINER_NAME:-cike}"
DATA_DIR="$ROOT/data"
STAMP="$(date +%Y%m%d-%H%M%S)"
IMAGE="cike:${CIKE_VERSION:-v1.0.0}"
PG_IMAGE="${CIKE_PG_IMAGE:-postgres:18-alpine}"
BACKUP_KEEP="${CIKE_BACKUP_KEEP:-10}"
HEALTH_TIMEOUT="${CIKE_HEALTH_TIMEOUT:-120}"

OLD_COMMIT=""
BACKUP_PATH=""
# 只有真正替换过容器才允许回滚：备份/构建阶段失败时容器还是旧的，没有可回滚的东西。
ROLLBACK_ARMED=0

info() { echo "==> $*"; }
fail() { echo "update_failed: $*" >&2; exit 1; }

# ---------------------------------------------------------------- 配置读取
# 从 .env 读一个键。用 `tail -n 1` 取最后一次定义，与 vgs / shifen 的口径一致。
env_value() {
    local key="$1" default="${2:-}" raw
    raw="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ROOT/.env" 2>/dev/null | tail -n 1 || true)"
    if [ -z "$raw" ]; then
        printf '%s' "$default"
        return 0
    fi
    raw="${raw#*=}"
    raw="${raw%\'}"; raw="${raw#\'}"
    raw="${raw%\"}"; raw="${raw#\"}"
    printf '%s' "$raw"
}

database_url() { env_value DATABASE_URL ""; }

# 把容器内用的连接串改成宿主机视角：
#   postgresql+psycopg://user:pass@postgresql:5432/db
#   → postgresql://user:pass@127.0.0.1:5432/db
# 备份/还原容器走 `--network host`，PG 只发布在 127.0.0.1:5432，
# 容器名 `postgresql` 在 host 网络里解析不到。
host_database_url() {
    local url
    url="$(database_url)"
    [ -n "$url" ] || { printf ''; return 0; }
    printf '%s' "$url" \
        | sed -E 's#^postgresql\+psycopg://#postgresql://#' \
        | sed -E 's#^(postgres(ql)?://)([^@/]*@)?[^/:]+#\1\3'"127.0.0.1"'#'
}

# ---------------------------------------------------------------- 备份 / 还原
prune_old_backups() {
    local directory="$1" pattern="$2" keep="$3" total path
    [ -d "$directory" ] || return 0
    total="$(find "$directory" -maxdepth 1 -type f -name "$pattern" | wc -l)"
    [ "$total" -le "$keep" ] && return 0
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        rm -f -- "$path" && echo "  已清理旧备份：$path"
    done < <(
        find "$directory" -maxdepth 1 -type f -name "$pattern" -printf '%T@\t%p\n' \
            | sort -rn | tail -n +"$((keep + 1))" | cut -f2-
    )
}

backup_database() {
    local url
    url="$(host_database_url)"
    if [ -z "$url" ]; then
        echo "!! 读不到 DATABASE_URL，跳过备份（回滚时将无法还原数据库）"
        return 0
    fi
    info "备份 PostgreSQL"
    mkdir -p "$DATA_DIR/backups"
    BACKUP_PATH="$DATA_DIR/backups/cike-$STAMP.dump"
    # 自定义格式（-Fc）：回滚时用 pg_restore --clean 精确还原到更新前。
    docker run --rm --network host \
        -e PGURL="$url" \
        -v "$DATA_DIR/backups:/backup" \
        "$PG_IMAGE" \
        sh -c 'pg_dump --no-owner --no-acl --format=custom \
               --file "/backup/cike-'"$STAMP"'.dump" "$PGURL"' \
        || fail "backup_failed"
    [ -s "$BACKUP_PATH" ] || fail "backup_failed（备份文件为空）"
    info "备份完成：$BACKUP_PATH"
    prune_old_backups "$DATA_DIR/backups" 'cike-*.dump' "$BACKUP_KEEP"
}

# 数据库回退：把备份灌回原库。
# `--clean --if-exists` 会先删掉库里已有对象，所以「新版本已经跑过迁移」的情况
# 也能退回到备份时的结构 —— 这正是旧脚本缺的那一环。
restore_database() {
    local url
    if [ -z "${BACKUP_PATH:-}" ] || [ ! -f "$BACKUP_PATH" ]; then
        echo "没有可用备份，跳过数据库回退"
        return 0
    fi
    url="$(host_database_url)"
    if [ -z "$url" ]; then
        echo "!! 读不到 DATABASE_URL，跳过数据库回退；请手动还原 $BACKUP_PATH"
        return 0
    fi
    echo "数据库回退到备份：$BACKUP_PATH"
    docker run --rm --network host \
        -e PGURL="$url" \
        -v "$DATA_DIR/backups:/backup:ro" \
        "$PG_IMAGE" \
        sh -c 'pg_restore --clean --if-exists --no-owner --no-acl \
               -d "$PGURL" "/backup/'"$(basename "$BACKUP_PATH")"'"' \
        || echo "!! 数据库回退失败，请手动还原：$BACKUP_PATH"
}

# ---------------------------------------------------------------- 容器
wait_healthy() {
    local timeout="$1" deadline status
    deadline=$((SECONDS + timeout))
    while [ "$SECONDS" -lt "$deadline" ]; do
        status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo missing)"
        case "$status" in
            healthy) return 0 ;;
            unhealthy) echo "容器健康检查未通过" >&2; return 1 ;;
        esac
        sleep 2
    done
    return 1
}

# ---------------------------------------------------------------- 回滚
git_state_hint() {
    local head remote dirty
    head="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    remote="$(git rev-parse --short origin/main 2>/dev/null || echo unknown)"
    dirty="$(git status --porcelain 2>/dev/null | wc -l)"
    echo
    echo "代码状态（回滚**未**改动工作树）："
    echo "  HEAD        = $head"
    echo "  origin/main = $remote"
    echo "  未提交改动  = $dirty 个文件"
    if [ "$dirty" -gt 0 ]; then
        git status --porcelain 2>/dev/null | head -10 | sed 's/^/    /'
    fi
    echo "  若要把代码也退回更新前（会丢弃本地未提交改动，确认后再执行）："
    echo "    git reset --hard ${OLD_COMMIT:-<更新前的提交>}"
    echo "  下次部署前记得重新 docker compose build。"
}

rollback() {
    trap - EXIT
    set +e
    echo
    echo "!! 更新失败，开始回滚"
    docker compose stop "$SERVICE" >/dev/null 2>&1
    restore_database
    if docker image inspect cike:previous >/dev/null 2>&1; then
        docker tag cike:previous "$IMAGE"
        echo "已把 $IMAGE 指回上一镜像"
    else
        echo "!! 没有 cike:previous 可用，镜像未回退"
    fi
    docker compose up -d >/dev/null 2>&1
    if wait_healthy 90; then
        echo "回滚完成：容器已用旧版本恢复"
    else
        docker compose stop "$SERVICE" >/dev/null 2>&1
        echo "!! 回滚后容器仍不健康，已停止服务"
        echo "   镜像: $IMAGE"
        echo "   备份: ${BACKUP_PATH:-无}"
        echo "   日志: docker compose logs --tail 100 $SERVICE"
    fi
    git_state_hint
    exit 1
}

cleanup() {
    local code=$?
    trap - EXIT
    if [ "$code" -ne 0 ] && [ "$ROLLBACK_ARMED" -eq 1 ]; then
        rollback
    fi
    exit "$code"
}
trap cleanup EXIT

# ---------------------------------------------------------------- 主流程
[ -f "$ROOT/.env" ] || fail "missing_env（先 cp .env.example .env 并填写）"

OLD_COMMIT="$(git rev-parse HEAD)"
dirty="$(git status --porcelain | wc -l)"

info "拉取 origin（当前 $(git rev-parse --short HEAD)，工作树未提交改动 ${dirty} 个文件）"
git pull --ff-only \
    || fail "git_pull_failed（工作树有本地改动，或历史已分叉；容器未被替换，无需回滚）"

backup_database

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker tag "$IMAGE" cike:previous
fi

info "构建镜像 $IMAGE"
docker compose build --build-arg GIT_COMMIT="$(git rev-parse --short HEAD)" \
    || fail "build_failed（容器未被替换，无需回滚）"

ROLLBACK_ARMED=1
info "重建容器"
docker compose up -d || fail "compose_up_failed"

info "等待健康检查（最长 ${HEALTH_TIMEOUT}s）"
wait_healthy "$HEALTH_TIMEOUT" || fail "healthcheck_failed"

info "更新完成：$(git rev-parse --short HEAD)"
