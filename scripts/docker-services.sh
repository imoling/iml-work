#!/usr/bin/env bash
# iML Work · Docker 增强服务一键起停：代码执行沙箱（iml-sandbox:py312）+ docling 文档解析。
# 后端栈（PostgreSQL / 后端 / 管理前端 / Mock）见 scripts/dev.sh；本脚本只管 Docker 平面。
#
# 用法：
#   bash scripts/docker-services.sh up            # colima 起 + 沙箱镜像就绪 + docling 起（默认）
#   bash scripts/docker-services.sh down          # 停 docling 容器（沙箱是一次性容器，无常驻可停）
#   bash scripts/docker-services.sh status        # 查 colima / 沙箱镜像 / docling / 本地 wheels
#   bash scripts/docker-services.sh build         # 只 build 沙箱镜像（有本地 wheels 则离线装）
#   bash scripts/docker-services.sh fetch-wheels  # 下载沙箱离线 wheel 到本地 wheels/（首次/换版本）
#   bash scripts/docker-services.sh save-images   # 把沙箱+docling 镜像 docker save 到 offline/*.tar（做离线包）
#   bash scripts/docker-services.sh load-images   # 从 offline/*.tar docker load（离线部署机用）
#
# 离线制品（都放本地项目、被 .gitignore 排除、不进仓）：
#   · docker/sandbox/wheels/   —— 沙箱预装包 wheel，供离线 build
#   · docker/offline/*.tar     —— 沙箱/docling 镜像 tar，供离线 docker load（免联网免 build）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_DIR="$ROOT/iml-work-admin/admin-backend/docker/sandbox"
OFFLINE_DIR="$ROOT/iml-work-admin/admin-backend/docker/offline"
DOCLING_COMPOSE="$ROOT/iml-work-admin/admin-backend/docker/docling/docker-compose.yml"
SANDBOX_IMAGE="iml-sandbox:py312"
DOCLING_IMAGE="ghcr.io/docling-project/docling-serve"
BASE_IMAGE="python:3.12-slim"

ensure_colima() {
  if docker info >/dev/null 2>&1; then echo "· Docker daemon 就绪。"; return; fi
  echo "· Docker daemon 不可达，启动 colima ..."
  colima start
  docker info >/dev/null 2>&1 || { echo "✗ Docker 仍不可达，请检查 colima。"; exit 1; }
  echo "· Docker daemon 就绪。"
}

fetch_wheels() {
  echo "· 在 linux 容器内下载离线 wheel → sandbox/wheels（平台匹配沙箱镜像）..."
  mkdir -p "$SANDBOX_DIR/wheels"
  docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || docker pull "$BASE_IMAGE"
  docker run --rm \
    -v "$SANDBOX_DIR/requirements.txt:/req.txt:ro" \
    -v "$SANDBOX_DIR/wheels:/wheels" \
    "$BASE_IMAGE" \
    pip download --no-cache-dir -r /req.txt -d /wheels
  echo "· 完成，本地 wheels：$(ls -1 "$SANDBOX_DIR/wheels"/*.whl 2>/dev/null | wc -l | tr -d ' ') 个"
}

build_sandbox() {
  mkdir -p "$SANDBOX_DIR/wheels"
  if ls "$SANDBOX_DIR/wheels"/*.whl >/dev/null 2>&1; then
    echo "· build 沙箱镜像 ${SANDBOX_IMAGE}（用本地离线 wheels）..."
  else
    echo "· build 沙箱镜像 ${SANDBOX_IMAGE}（wheels 为空 → 联网装；可先 fetch-wheels 转离线）..."
  fi
  docker build -t "$SANDBOX_IMAGE" "$SANDBOX_DIR"
  echo "· 沙箱镜像就绪。"
}

save_images() {
  mkdir -p "$OFFLINE_DIR"
  if docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
    echo "· save 沙箱镜像 → offline/iml-sandbox-py312.tar ..."
    docker save "$SANDBOX_IMAGE" -o "$OFFLINE_DIR/iml-sandbox-py312.tar"
  else
    echo "  ⚠ 沙箱镜像 ${SANDBOX_IMAGE} 不在，先 build。"
  fi
  if docker image inspect "$DOCLING_IMAGE" >/dev/null 2>&1; then
    echo "· save docling 镜像 → offline/docling-serve.tar（较大，稍候）..."
    docker save "$DOCLING_IMAGE" -o "$OFFLINE_DIR/docling-serve.tar"
  else
    echo "  ⚠ docling 镜像不在，先 up（拉取）。"
  fi
  ls -lh "$OFFLINE_DIR"/*.tar 2>/dev/null || true
}

load_images() {
  local found=0
  for t in "$OFFLINE_DIR"/*.tar; do
    [ -f "$t" ] || continue
    found=1
    echo "· load $(basename "$t") ..."
    docker load -i "$t"
  done
  [ "$found" = 1 ] || echo "  ⚠ ${OFFLINE_DIR} 下没有 *.tar；先在有网机器 save-images 再把目录拷过来。"
}

has_compose() { docker compose version >/dev/null 2>&1; }

up() {
  ensure_colima
  if docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then echo "· 沙箱镜像已在。"; else build_sandbox; fi
  echo "· 起 docling ..."
  if has_compose; then
    docker compose -f "$DOCLING_COMPOSE" up -d
  else
    # colima 默认无 compose 插件 → 退化为裸 docker run（单容器，等价于 compose 文件的定义）
    if docker ps -a --format '{{.Names}}' | grep -q '^iml-docling-serve$'; then
      docker start iml-docling-serve >/dev/null
    else
      docker run -d --name iml-docling-serve -p 5001:5001 \
        -e LOAD_MODELS_AT_BOOT=false --restart unless-stopped \
        "$DOCLING_IMAGE" >/dev/null
    fi
  fi
  echo ""
  status
}

down() {
  if has_compose; then docker compose -f "$DOCLING_COMPOSE" down 2>/dev/null || true
  else docker rm -f iml-docling-serve >/dev/null 2>&1 || true; fi
  echo "· docling 已停（沙箱为一次性容器，无常驻进程可停）。"
}

status() {
  echo "── Docker 增强服务状态 ──"
  if ! docker info >/dev/null 2>&1; then echo "  colima/daemon : ✗ 不可达（bash scripts/docker-services.sh up 会自动起）"; return; fi
  echo "  colima/daemon : ✓ 可达"
  if docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then echo "  沙箱镜像      : ✓ $SANDBOX_IMAGE"; else echo "  沙箱镜像      : ✗ 未 build（… build）"; fi
  if docker ps --filter "name=iml-docling-serve" --format '{{.Status}}' 2>/dev/null | grep -q .; then
    echo "  docling       : ✓ $(docker ps --filter name=iml-docling-serve --format '{{.Status}}')  → http://localhost:5001"
  else
    echo "  docling       : ✗ 未运行（… up）"
  fi
  echo "  本地 wheels   : $(ls -1 "$SANDBOX_DIR/wheels"/*.whl 2>/dev/null | wc -l | tr -d ' ') 个离线包"
  echo "  离线镜像 tar  : $(ls -1 "$OFFLINE_DIR"/*.tar 2>/dev/null | wc -l | tr -d ' ') 个（offline/）"
}

case "${1:-up}" in
  up)           up ;;
  down)         down ;;
  status)       status ;;
  build)        ensure_colima; build_sandbox ;;
  fetch-wheels) ensure_colima; fetch_wheels ;;
  save-images)  ensure_colima; save_images ;;
  load-images)  ensure_colima; load_images ;;
  *) echo "用法: bash scripts/docker-services.sh {up|down|status|build|fetch-wheels|save-images|load-images}"; exit 1 ;;
esac
