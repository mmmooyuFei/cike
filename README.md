# 此刻 · 笔记 · 备忘录

自托管的个人工作台「笔记 · 备忘录」，覆盖驾驶舱、短期待办、里程碑、每日日志、睡眠、专注学习、健身与月度账户余额。站点名称与副标题可在「账号设置 → 品牌与外观」修改，默认分别为「此刻」与「笔记 · 备忘录」。

## 功能

- 驾驶舱：短期待办、专注、睡眠、运动、学习与资金聚合
- 短期待办：优先级、分类、截止日期、完成状态
- 坚持打卡：每天 / 每周 / 每月目标，一键打卡，月度进度与连续天数
- 里程碑：目标、衡量标准、进度与复盘
- 每日日志：今日内容、明日计划、卡点
- 睡眠：睡前 / 起床打卡、达标判断、跨日归并
- 专注学习：时段记录、类型、收获与可落地动作
- 健身：项目、时长、强度与消耗
- 资金：按账户记录月度期初 / 期末，自动计算净变动与个人总余额（各账户最新期末加总）
- 账号：资料、头像（支持透明底 PNG）、密码、角色与访问范围
- 站点管理：管理员配置品牌名称 / 副标题 / LOGO，以及按 Casdoor 角色 / 群组限制模块可见与可编辑
- 更新管理：管理员查看运行版本、仓库状态与最近提交；挂载仓库后可检查远端并 `git pull`
- 数据：按登录用户隔离；软删除可撤销；支持 JSON / CSV 导出

## 技术栈

- 前端：React 19、Vite、TypeScript
- 后端：FastAPI、SQLAlchemy、PostgreSQL
- 登录：Casdoor OIDC（授权码流程）
- 部署：Docker Compose、1Panel / OpenResty、CNB Git 镜像

## 环境要求

- Docker Engine 24+ 与 Docker Compose v2
- PostgreSQL 14+
- Casdoor 4.x（OIDC）
- 可选：1Panel / OpenResty（HTTPS 反向代理）
- 可选：CNB 仓库（镜像 GitHub 分支与标签）

## 快速开始

### 1. 创建数据库

在现有 PostgreSQL 中创建独立角色与数据库：

```sql
CREATE ROLE cike LOGIN PASSWORD '<strong-password>';
CREATE DATABASE cike OWNER cike;
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`，至少填写：

- `DATABASE_URL`：PostgreSQL 连接串（容器内使用服务别名）
- `DOCKER_NETWORK`：PostgreSQL 容器所在的 Docker 网络名
- `SESSION_SECRET`：随机字符串
- `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`OIDC_REDIRECT_URI`

### 3. 启动

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:9543/api/health
```

### 4. 反向代理

应用只监听 `127.0.0.1:9543`，由 1Panel / OpenResty 提供 HTTPS。使用现有 1Panel 通配证书时：

```bash
DOMAIN=workbench.example.com \
CERT_SOURCE=/opt/1panel/www/sites/example.com \
bash scripts/1panel-site.sh
```

`CERT_SOURCE` 是包含 `ssl/fullchain.pem` 与 `ssl/privkey.pem` 的站点目录。脚本会生成 8443 server 配置、校验并热加载 OpenResty；改动前会备份原配置。

> 如果站点需要在 1Panel 的「网站」列表中管理，请在 1Panel 中创建反向代理站点并选择已有通配证书；本脚本只生成 OpenResty 配置，不写入 1Panel 数据库。

### 5. Casdoor

在目标组织下创建应用：

- Redirect URI：`https://workbench.example.com/api/auth/oidc/callback`
- Grant：Authorization Code + Refresh Token
- Scopes：`openid profile email`
- 关闭自助注册
- 创建角色 `admin`，并将站点管理员账号加入
- 将 Client ID / Secret 写入服务器 `.env`

若 IdP 不支持 PKCE，保持 `OIDC_PKCE=false`。

## 配置项

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | PostgreSQL 连接串，格式 `postgresql+psycopg://user:pass@host:5432/db` |
| `DOCKER_NETWORK` | 是 | PostgreSQL 容器所在 Docker 网络；应用会加入该网络 |
| `SESSION_SECRET` | 是 | 会话与令牌加密密钥，随机长字符串 |
| `COOKIE_SECURE` | 是 | HTTPS 环境为 `true` |
| `OIDC_ISSUER` | 是 | Casdoor issuer，例如 `https://auth.example.com` |
| `OIDC_CLIENT_ID` | 是 | OIDC 应用 Client ID |
| `OIDC_CLIENT_SECRET` | 是 | OIDC 应用 Client Secret |
| `OIDC_REDIRECT_URI` | 是 | 与 Casdoor 登记值完全一致 |
| `OIDC_SCOPES` | 否 | 默认 `openid profile email` |
| `OIDC_PKCE` | 否 | IdP 支持 PKCE 时设为 `true`，默认 `false` |
| `OIDC_DISPLAY_NAME` | 否 | 登录按钮与跳转页显示的身份提供方名称 |
| `OIDC_AUTO_LOGIN` | 否 | 默认 `true`：未登录时自动跳转统一认证 |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | 否 | RP 退出后回跳地址，需在 IdP 应用登记 |
| `ADMIN_ROLE` | 否 | 站点管理员角色名，默认 `admin` |
| `CASDOOR_ADMIN_USER` | 否 | 角色定义重算与资料写回所需的 IdP 管理员账号 |
| `CASDOOR_ADMIN_PASSWORD` | 否 | 上项口令 |
| `CASDOOR_APPLICATION` | 否 | 管理员登录使用的 IdP Application |
| `BRAND_DEFAULT_NAME` | 否 | 默认品牌名，默认「此刻」 |
| `BRAND_DEFAULT_SUBTITLE` | 否 | 默认副标题，默认「笔记 · 备忘录」 |
| `APP_TIMEZONE` | 否 | 计算“今天”所用时区，默认 `Asia/Shanghai`；不依赖容器 `TZ` |
| `UPDATE_REPO_DIR` | 否 | 容器内挂载的仓库路径；设置后「更新管理」可检查远端 / 拉取 |
| `UPDATE_ALLOW_RESTART` | 否 | 是否允许页面重启进程，默认 `false`（需容器 restart 策略） |
| `APP_GIT_COMMIT` | 否 | 构建时写入的提交号，由 `update.sh` 传入，无需手工填 |
| `DATA_DIR` | 否 | 运行期数据目录，默认 `data` |

## 部署说明

- 容器仅绑定 `127.0.0.1:9543`，不直接暴露公网。
- 应用与 PostgreSQL 容器加入同一 Docker 网络，通过服务别名访问数据库。
- 数据库口令、OIDC Secret、会话密钥只存在于服务器 `.env`，不进入镜像或仓库。
- 健康检查：`GET /api/health`。

## 更新与备份

```bash
bash scripts/update.sh
```

流程：拉取代码 → `pg_dump` 备份 → 构建镜像（写入提交号 `GIT_COMMIT`）→ 重建容器 → 健康检查；失败时回滚上一镜像。备份保留最近 10 份。

### 更新管理页面

管理员可在「管理 → 更新管理」查看：

- 运行版本：镜像构建时写入的提交号与部署方式
- 仓库状态：分支 / 当前提交 / 提交时间 / 未提交改动 / 远端地址（不含凭据）
- 最近提交，以及当前运行提交是否与仓库 HEAD 一致
- 「检查远端」「拉取更新」：`docker-compose.yml` 已把项目目录挂到容器 `/repo`（`UPDATE_REPO_DIR=/repo`），页面可以直接执行 `git fetch` / `git pull --ff-only`

页面上的「拉取更新」只更新仓库；重建镜像与健康检查仍走 `scripts/update.sh`。不想让页面拉代码时，把挂载改成 `./:/repo:ro` 即可（页面会显示“只读挂载”，只能看提交）。

「重启服务」默认关闭，需要 `UPDATE_ALLOW_RESTART=true` 且容器有 `restart` 策略。

## CNB 镜像

1. 在 CNB 创建目标仓库。
2. 创建 CNB 访问令牌（仓库读写）。
3. 在 GitHub 仓库添加两个 Actions Secret：
   - `CNB_TOKEN`：CNB 访问令牌
   - `CNB_REPO`：CNB 仓库地址，不含协议与凭据，例如 `cnb.cool/group/repo.git`
4. 推送 GitHub `main` 后，`.github/workflows/sync-cnb.yml` 会镜像所有分支与标签。
5. 服务器 `origin` 指向 CNB 仓库；公开仓库可直接 `git pull`。

## 安全

- 仓库只包含 `.env.example`，不包含 `.env`、密钥、证书或数据库文件。
- 业务读写均带当前 `user_id` 条件；越权返回 404。
- 生产关闭开发登录；会话 Cookie 为 HttpOnly + SameSite=Lax + Secure。
- 写请求校验 CSRF；删除为软删除并支持撤销。
- 管理接口仅对 `ADMIN_ROLE` 角色开放。

## 数据库

表与字段说明见 [docs/数据库表结构.md](docs/数据库表结构.md)。表在容器启动时自动创建；
目前共 15 张表（5 张系统表 + 10 张业务表），业务数据按 `user_id` 隔离，删除为软删除。

## 目录

```
backend/                 FastAPI 应用、模型、路由、测试
frontend/                React + Vite 前端
docs/数据库表结构.md      表、字段、约束与常用查询
scripts/update.sh        生产更新与回滚
scripts/1panel-site.sh   1Panel 8443 站点生成
.github/workflows/       GitHub → CNB 镜像
docker-compose.yml
Dockerfile
.env.example
```
