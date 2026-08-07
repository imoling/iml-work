#!/usr/bin/env bash
# iML Work 服务端一键安装（不需要克隆代码仓）。
# 干的事：查前置 → 起 PostgreSQL+pgvector（docker）→ 生成随机密钥 → 写 config/application.yml
#         → 启动后端 → 打印下一步。全程幂等，重复执行不会覆盖已填好的配置。
#
# 用法： ./install.sh            交互式（会问初始超管口令）
#        ADMIN_PASSWORD=xxx ./install.sh --yes   全自动
set -euo pipefail
cd "$(dirname "$0")"

PG_CONTAINER="${PG_CONTAINER:-iml-postgres}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-imlwork}"
PG_USER="${PG_USER:-imlwork}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg17}"
ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1

say()  { printf "\033[36m%s\033[0m\n" "$*"; }
ok()   { printf "\033[32m✓ %s\033[0m\n" "$*"; }
warn() { printf "\033[33m! %s\033[0m\n" "$*"; }
die()  { printf "\033[31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

# ── ① 前置检查 ──────────────────────────────────────────────────────────────
say "① 检查运行环境"

JAVA_BIN=java
[ -d /opt/homebrew/opt/openjdk@21 ] && JAVA_BIN=/opt/homebrew/opt/openjdk@21/bin/java
command -v "$JAVA_BIN" >/dev/null 2>&1 || die "未找到 java。请先装 JDK 21（Linux: apt install openjdk-21-jre / yum install java-21-openjdk）。"
JV=$("$JAVA_BIN" -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"')
[ "${JV:-0}" -ge 21 ] || die "Java 版本为 $JV，本项目需要 21+。"
ok "Java $JV"

command -v docker >/dev/null 2>&1 || die "未找到 docker。PostgreSQL(pgvector)、沙箱、文档解析都靠它。"
docker info >/dev/null 2>&1 || die "docker 装了但没跑起来（daemon 不可达）。先启动 Docker 再重跑。"
ok "Docker 就绪"

command -v openssl >/dev/null 2>&1 || die "未找到 openssl（用于生成密钥）。"

# ── ② PostgreSQL + pgvector ─────────────────────────────────────────────────
say "② 准备 PostgreSQL（pgvector）"

if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER" || docker start "$PG_CONTAINER" >/dev/null
  ok "复用已有容器 $PG_CONTAINER（未改动其数据）"
  PG_PASSWORD="${PG_PASSWORD:-}"
  [ -n "$PG_PASSWORD" ] || {
    # 容器已存在但本次没给密码：从上次生成的配置里捞，捞不到就要求显式传入
    if [ -f config/application.yml ]; then
      PG_PASSWORD=$(grep -A3 '^\s*datasource:' config/application.yml | grep 'password:' | head -1 | sed 's/.*password: *"\{0,1\}//; s/"\{0,1\}$//')
    fi
    [ -n "$PG_PASSWORD" ] || die "容器 $PG_CONTAINER 已存在但拿不到库密码。请用 PG_PASSWORD=xxx 重跑。"
  }
else
  PG_PASSWORD="${PG_PASSWORD:-$(openssl rand -hex 16)}"
  # 显式先拉再跑：镜像 400MB+，网络抖动时 docker run 的隐式拉取会中途 EOF，
  # 报一句「short read: expected N bytes」就把脚本带死，看不出是网络问题。这里重试 3 次。
  if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
    say "   拉取 $PG_IMAGE（约 400MB，慢的话是在下载）..."
    PULLED=0
    for attempt in 1 2 3; do
      if docker pull "$PG_IMAGE"; then PULLED=1; break; fi
      warn "第 ${attempt} 次拉取失败（多为网络中断），重试中..."
      sleep 5
    done
    [ "$PULLED" = 1 ] || die "镜像拉取三次均失败。网络受限时可在有网机器上 docker save 成 tar 拷过来 docker load，再重跑本脚本。"
  fi
  say "   创建容器 $PG_CONTAINER ..."
  docker run -d --name "$PG_CONTAINER" --restart unless-stopped \
    -e POSTGRES_DB="$PG_DB" -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -p "${PG_PORT}:5432" -v "${PG_CONTAINER}-data:/var/lib/postgresql/data" \
    "$PG_IMAGE" >/dev/null
  ok "容器已创建（数据卷 ${PG_CONTAINER}-data，删容器不丢数据）"
fi

printf "   等待数据库就绪"
for i in $(seq 1 60); do
  if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then break; fi
  printf "."; sleep 1
  [ "$i" = 60 ] && die "数据库 60s 未就绪，看 docker logs $PG_CONTAINER"
done
echo ""
# pgvector 扩展：Flyway 迁移里建向量索引前必须先有扩展
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1 \
  && ok "pgvector 扩展就绪" || warn "pgvector 扩展创建失败——若用的不是 pgvector 镜像，请自行安装"

# ── ③ 生成配置 ──────────────────────────────────────────────────────────────
say "③ 生成外置配置 config/application.yml"

if [ -f config/application.yml ]; then
  ok "已存在，跳过（要重新生成请先删掉它）"
else
  if [ -n "${ADMIN_PASSWORD:-}" ]; then
    ADM="$ADMIN_PASSWORD"
  elif [ "$ASSUME_YES" = 1 ]; then
    ADM=$(openssl rand -base64 12 | tr -d '/+=' | head -c 16)
    warn "未给 ADMIN_PASSWORD，已随机生成（下面会打印，请立刻记下来）"
  else
    printf "   设置初始超管口令（admin 账号，勿用 admin123）: "
    read -rs ADM; echo ""
    [ -n "$ADM" ] || die "口令不能为空。"
  fi

  mkdir -p config
  cat > config/application.yml <<YAML
# iML Work 后端配置 —— install.sh 自动生成于安装时。密钥已随机化，请勿提交进 git。
spring:
  profiles:
    active: prod          # prod：不播演示数据（岗位/知识库/假业务系统/企业档案全部跳过），
                          #       密钥弱或缺即拒启动。预置技能仍会播种（那是产品能力，不是假数据）。
  threads:
    virtual:
      enabled: true
  datasource:
    url: jdbc:postgresql://127.0.0.1:${PG_PORT}/${PG_DB}
    username: ${PG_USER}
    password: "${PG_PASSWORD}"
    hikari:
      maximum-pool-size: 20

security:
  jwt:
    secret: "$(openssl rand -base64 48)"
    ttl-hours: 72
  confirm:
    hmac-secret: "$(openssl rand -base64 48)"
  initial-admin-password: "${ADM}"

# 模型网关闸门。/api/v1/model/chat 是 permitAll，corp-key 是它唯一的门——prod 下缺失或
# 沿用源码里的开发默认值即拒启动。员工客户端零配置走登录 JWT，不需要知道这个 key；
# 只有「客户端自配模型」等旁路才用它覆盖。这里随机生成即可。
model-proxy:
  corp-key: "$(openssl rand -hex 24)"

# 管理前端与后端同源经 nginx 反代时留空即可；分域名部署才需要填
cors:
  allowed-origins: ""
YAML
  chmod 600 config/application.yml
  ok "已生成（含随机 JWT/HMAC 密钥，权限 600）"
  echo "$ADM" > .admin-password.txt && chmod 600 .admin-password.txt
  warn "初始超管口令已写入 .admin-password.txt —— 首次登录后请改密并删除该文件"
fi

# ── ④ 启动后端 ──────────────────────────────────────────────────────────────
say "④ 启动后端"
mkdir -p logs
nohup ./start.sh > logs/backend.log 2>&1 &
BACKEND_PID=$!
printf "   等待后端就绪（首次启动要跑 Flyway 迁移 + 播种 9 个预置技能，约 30-60s）"
UP=0
for i in $(seq 1 120); do
  if curl -fs "http://127.0.0.1:8080/api/v1/auth/me" >/dev/null 2>&1 \
     || curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080/api/v1/auth/me" 2>/dev/null | grep -qE '^(401|403)$'; then
    UP=1; break
  fi
  kill -0 "$BACKEND_PID" 2>/dev/null || { echo ""; die "后端进程已退出，看 logs/backend.log"; }
  printf "."; sleep 1
done
echo ""
[ "$UP" = 1 ] || die "后端 120s 未就绪，看 logs/backend.log"
ok "后端已启动（pid $BACKEND_PID，端口 8080，日志 logs/backend.log）"

# ── ⑤ 下一步 ────────────────────────────────────────────────────────────────
cat <<EOF

$(say "安装完成")

  后端     http://127.0.0.1:8080   （pid $BACKEND_PID · 日志 logs/backend.log）
  超管账号 admin
  超管口令 $([ -f .admin-password.txt ] && cat .admin-password.txt || echo "（沿用已有配置）")

接下来还有两步，见 README.md：

  1. 托管管理前端 —— 解压 admin-frontend.tar.gz，按 nginx.conf.example 配好 nginx。
     （前端打自己的 /api，必须同源反代到 8080，不能前后端分开挂两个域名）

  2. 起配套服务 —— ./docker-services.sh up
     文档解析(docling) · 向量模型(bge-m3) · 代码沙箱 · 自托管检索(searxng)
     ⚠ 向量模型缺失时系统不报错，检索会静默退化成字面匹配、知识库形同虚设，务必核验。

停后端： kill $BACKEND_PID      重启： ./start.sh
EOF
