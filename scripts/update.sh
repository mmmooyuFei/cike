#!/usr/bin/env bash
# 生产更新：拉取 CNB 镜像仓库 → 备份 PostgreSQL → 构建 → 重建 → 健康检查 → 失败回滚。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SERVICE="cike"
DATA_DIR="$ROOT/data"
STAMP="$(date +%Y%m%d-%H%M%S)"
IMAGE="cike:${CIKE_VERSION:-v1.0.0}"

info() { echo "==> $*"; }
fail() { echo "update_failed: $*" >&2; exit 1; }

[ -f .env ] || fail "missing .env"
mkdir -p "$DATA_DIR/backups"

info "拉取 origin"
git pull --ff-only

info "备份 PostgreSQL"
if docker compose ps --status running "$SERVICE" >/dev/null 2>&1; then
  docker compose exec -T "$SERVICE" sh -c "URL=\$(printf '%s' \"\$DATABASE_URL\" | sed 's#postgresql+psycopg://#postgresql://#'); pg_dump \"\$URL\" -f /app/data/backups/cike-$STAMP.sql" \
    || fail "backup_failed"
  find "$DATA_DIR/backups" -maxdepth 1 -name 'cike-*.sql' -printf '%T@ %p\n' \
    | sort -rn | tail -n +11 | cut -d' ' -f2- | xargs -r rm -f
else
  info "容器未运行，跳过在线备份"
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" cike:previous
fi

info "构建镜像"
docker compose build --build-arg GIT_COMMIT="$(git rev-parse --short HEAD)" || fail "build_failed"

info "重建容器"
docker compose up -d || fail "compose_up_failed"

info "等待健康检查"
deadline=$((SECONDS + 120))
while [ "$SECONDS" -lt "$deadline" ]; do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cike 2>/dev/null || echo missing)"
  if [ "$status" = "healthy" ]; then
    info "更新完成：$(git rev-parse --short HEAD)"
    exit 0
  fi
  if [ "$status" = "unhealthy" ] || [ "$status" = "exited" ]; then
    break
  fi
  sleep 2
done

info "健康检查失败，回滚上一镜像"
if docker image inspect cike:previous >/dev/null 2>&1; then
  docker tag cike:previous "$IMAGE"
  docker compose up -d || true
fi
fail "healthcheck_failed"
