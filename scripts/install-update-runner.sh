#!/usr/bin/env bash
# 安装宿主机重建执行器，让「更新管理」页面的「拉取并重建」真正生效。
#
# 会做三件事：
# 1. 写 systemd 单元 <name>-wake.path / <name>.service（按仓库所在路径生成，不含硬编码路径）；
# 2. 在数据目录写 update-runner.json 标记——页面看到它才开放「拉取并重建」；
# 3. daemon-reload 并启用 path 单元。
#
# 用法：sudo bash scripts/install-update-runner.sh
# 卸载：sudo systemctl disable --now <name>-wake.path && rm /etc/systemd/system/<name>-wake.path /etc/systemd/system/<name>.service
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${CIKE_DATA_DIR:-$ROOT/data}"
UNIT_DIR="${CIKE_UNIT_DIR:-/etc/systemd/system}"
NAME="${CIKE_UNIT_NAME:-cike-update}"

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root 权限：sudo bash scripts/install-update-runner.sh" >&2
  exit 1
fi
if [ ! -d "$ROOT/.git" ]; then
  echo "在仓库根目录运行（找不到 $ROOT/.git）" >&2
  exit 1
fi
if [ ! -f "$ROOT/scripts/update-dispatch.sh" ]; then
  echo "缺少 scripts/update-dispatch.sh" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "这台机器没有 systemd，无法安装宿主执行器" >&2
  exit 1
fi
for bin in flock python3 git tee; do
  command -v "$bin" >/dev/null 2>&1 || { echo "缺少依赖命令：$bin" >&2; exit 1; }
done

mkdir -p "$DATA_DIR" "$UNIT_DIR"

cat >"$UNIT_DIR/$NAME-wake.path" <<EOF
[Unit]
Description=监视站点更新唤醒（拉取更新后自动安全重建）

[Path]
PathChanged=$DATA_DIR/update-wake
Unit=$NAME.service

[Install]
WantedBy=paths.target
EOF

cat >"$UNIT_DIR/$NAME.service" <<EOF
[Unit]
Description=站点安全重建：备份 -> 构建镜像 -> 重建容器 -> 健康检查 -> 失败回滚
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $ROOT/scripts/update-dispatch.sh
TimeoutStartSec=1800
Nice=10
EOF

printf '{"runner":"systemd-path","version":1,"root":"%s","installed_at":"%s"}\n' \
  "$ROOT" "$(date -Is)" >"$DATA_DIR/update-runner.json"

systemctl daemon-reload
systemctl enable --now "$NAME-wake.path"
systemctl status --no-pager --lines=0 "$NAME-wake.path" || true

echo
echo "已安装：$UNIT_DIR/$NAME-wake.path -> $NAME.service"
echo "现在页面上的「拉取并重建」由宿主机执行，日志在 $DATA_DIR/update.log。"
echo "试跑一次：sudo systemctl start $NAME.service"
