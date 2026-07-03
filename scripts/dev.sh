#!/usr/bin/env bash
# 一键拉起后端依赖服务（本地开发）：PostgreSQL(pgvector) → 后端 → 管理前端 → Mock OA。
# 桌面端(iml-work-client / iml-fde-studio)是 Electron 应用，请各自 `npm run dev` 单独启动。
#
# 用法：  bash scripts/dev.sh
# 停止：  Ctrl-C（会一并停掉本脚本拉起的后台进程）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/iml-work-admin/admin-backend"
ADMIN_FE="$ROOT/iml-work-admin/admin-frontend"
MOCK_OA="$ROOT/iml-mock-oa"
LOG_DIR="$ROOT/.devlogs"
mkdir -p "$LOG_DIR"

# Java 21：优先用 Homebrew 的 openjdk@21（若存在）。
if [ -d /opt/homebrew/opt/openjdk@21 ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@21
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# 代理透传：Java 的 HttpClient 只认 -Dhttp(s).proxyHost 系统属性、不读 HTTP_PROXY 环境变量。
# 若 shell 设了 HTTP_PROXY/HTTPS_PROXY，转成 JAVA_TOOL_OPTIONS，让后端调用上游模型时走代理，
# 否则在需代理的网络里模型通道会因直连失败被熔断降级为 mock。
PXY="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
if [ -n "$PXY" ]; then
  PXY_HP="${PXY#*://}"; PXY_HOST="${PXY_HP%%:*}"; PXY_PORT="${PXY_HP##*:}"
  if [ -n "$PXY_HOST" ] && [ -n "$PXY_PORT" ]; then
    export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Dhttp.proxyHost=$PXY_HOST -Dhttp.proxyPort=$PXY_PORT -Dhttps.proxyHost=$PXY_HOST -Dhttps.proxyPort=$PXY_PORT -Dhttp.nonProxyHosts=localhost|127.0.0.1"
    echo "· 检测到代理 $PXY_HOST:$PXY_PORT → 已透传给后端 JVM（上游模型调用走代理）。"
  fi
fi

PIDS=()
cleanup() {
  echo ""
  echo "→ 正在停止后台进程 ..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  echo "→ 已停止。PostgreSQL 容器仍在运行，如需停止： (cd \"$BACKEND\" && docker compose down)"
}
trap cleanup INT TERM

if lsof -ti tcp:5432 >/dev/null 2>&1; then
  echo "① PostgreSQL 已在 :5432 运行（docker 或本机原生），跳过启动。"
elif command -v docker >/dev/null 2>&1; then
  echo "① 用 docker compose 启动 PostgreSQL (pgvector) ..."
  (cd "$BACKEND" && docker compose up -d)
  echo "② 等待数据库就绪 ..."
  for i in $(seq 1 30); do
    if (cd "$BACKEND" && docker compose exec -T postgres pg_isready -U imlwork >/dev/null 2>&1); then
      echo "   数据库就绪。"; break
    fi
    sleep 1
    [ "$i" = "30" ] && echo "   ⚠️ 数据库超时未就绪，继续尝试启动后端 ..."
  done
else
  echo "① ⚠️ 未检测到 :5432 上的 PostgreSQL，且本机无 docker。"
  echo "   请先启动 PostgreSQL(pgvector)：docker compose（见 admin-backend/README）或本机 postgres@17。"
  exit 1
fi

echo "③ 启动后端 (Spring Boot :8080) → $LOG_DIR/backend.log"
(cd "$BACKEND" && mvn -q -ntp spring-boot:run) >"$LOG_DIR/backend.log" 2>&1 &
PIDS+=($!)

echo "④ 启动管理前端 (Vite :3000) → $LOG_DIR/admin-frontend.log"
(cd "$ADMIN_FE" && npm run dev) >"$LOG_DIR/admin-frontend.log" 2>&1 &
PIDS+=($!)

if [ -d "$MOCK_OA" ]; then
  echo "⑤ 启动 Mock OA/CRM (:8090) → $LOG_DIR/mock-oa.log"
  (cd "$MOCK_OA" && npm start) >"$LOG_DIR/mock-oa.log" 2>&1 &
  PIDS+=($!)
fi

echo ""
echo "全部拉起。访问："
echo "  · 管理后台      http://localhost:3000"
echo "  · 后端 API      http://localhost:8080/api/v1"
echo "  · Mock OA/CRM   http://localhost:8090"
echo "  · 桌面客户端/FDE 请各自 'npm run dev'"
echo "日志目录：$LOG_DIR （.devlogs 已 gitignore）"
echo "按 Ctrl-C 停止。"
wait
