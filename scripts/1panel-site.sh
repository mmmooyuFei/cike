#!/usr/bin/env bash
# 在 1Panel 中新增 / 刷新一个 8443 反向代理站点。
# 必需环境变量：
#   DOMAIN       站点域名
#   CERT_SOURCE  包含 ssl/fullchain.pem 与 ssl/privkey.pem 的目录
# 可选：
#   PORT         后端端口，默认 9543
#   PANEL        1Panel 根目录，默认 /opt/1panel
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN}"
CERT_SOURCE="${CERT_SOURCE:?set CERT_SOURCE to a directory containing ssl/fullchain.pem and ssl/privkey.pem}"
PORT="${PORT:-9543}"
PANEL="${PANEL:-/opt/1panel}"
SITE="$PANEL/www/sites/$DOMAIN"
CONF="$PANEL/www/conf.d/$DOMAIN.conf"
BACKUP_DIR="$PANEL/backups"

info() { echo "==> $*"; }
fail() { echo "site_failed: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "需要 root"
[ -f "$CERT_SOURCE/ssl/fullchain.pem" ] || fail "找不到证书：$CERT_SOURCE/ssl/fullchain.pem"
[ -f "$CERT_SOURCE/ssl/privkey.pem" ] || fail "找不到证书私钥：$CERT_SOURCE/ssl/privkey.pem"

mkdir -p "$SITE/proxy" "$SITE/ssl" "$SITE/log" "$SITE/index" "$BACKUP_DIR"
cp -n "$CERT_SOURCE/ssl/fullchain.pem" "$SITE/ssl/fullchain.pem"
cp -n "$CERT_SOURCE/ssl/privkey.pem" "$SITE/ssl/privkey.pem"

cat > "$SITE/proxy/root.conf" <<EOF
location ^~ / {
    proxy_pass http://127.0.0.1:${PORT};
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header REMOTE-HOST \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_http_version 1.1;
    proxy_ssl_server_name off;
    proxy_ssl_name \$proxy_host;
}
EOF

cat > "$SITE/proxy/zz-8443-custom.conf" <<'EOF'
client_max_body_size 64m;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
proxy_buffering off;
EOF

if [ -f "$CONF" ]; then
  cp -a "$CONF" "$BACKUP_DIR/$DOMAIN.conf.bak.$(date +%Y%m%d-%H%M%S)"
fi

cat > "$CONF" <<EOF
server {
    listen 80 ;
    listen 8443 ssl ;
    server_name ${DOMAIN};
    access_log /www/sites/${DOMAIN}/log/access.log main;
    error_log /www/sites/${DOMAIN}/log/error.log;
    location ~ ^/(\.user.ini|\.htaccess|\.git|\.env|\.svn|\.project|LICENSE|README.md) {
        return 404;
    }
    http2 on;
    if (\$scheme = http) {
        return 301 https://\$host:8443\$request_uri;
    }
    ssl_certificate /www/sites/${DOMAIN}/ssl/fullchain.pem;
    ssl_certificate_key /www/sites/${DOMAIN}/ssl/privkey.pem;
    ssl_protocols TLSv1.3 TLSv1.2;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    error_page 497 https://\$host:8443\$request_uri;
    proxy_set_header X-Forwarded-Proto https;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";
    root /www/sites/${DOMAIN}/index;
    include /www/sites/${DOMAIN}/proxy/*.conf;
}
EOF

C="$(docker ps --filter 'name=1Panel-openresty' --format '{{.Names}}' | head -1)"
[ -n "$C" ] || fail "找不到 1Panel OpenResty 容器"

info "语法校验"
if ! docker exec "$C" openresty -t; then
  fail "openresty 语法校验失败，请检查 $CONF"
fi

info "热加载"
docker exec "$C" openresty -s reload

info "验证"
curl -sk --resolve "$DOMAIN:8443:127.0.0.1" "https://$DOMAIN:8443/api/health" \
  -o /dev/null -w "https://$DOMAIN:8443/api/health -> %{http_code}\n" || true

info "完成：$DOMAIN -> 127.0.0.1:$PORT"
