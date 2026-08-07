#!/usr/bin/env bash
# 组装 GitHub Release 产物 → dist/release/
#
#   iml-work-server-<版本>.tar.gz   服务端一体包（jar + 前端静态 + 脚本 + 文档），解压即可私有化部署
#   iML-Work-<版本>-mac-arm64.dmg   员工客户端（Apple Silicon）
#   iML-Work-<版本>-mac-x64.dmg     员工客户端（Intel Mac）
#   iML-Work-<版本>-win-x64.exe     员工客户端（Windows）
#   SHA256SUMS.txt                  全部产物校验和
#
# 客户端安装包不在这里构建（要 macOS + 几十分钟），先自行跑：
#   cd iml-work-client && npx electron-builder --mac && npx electron-builder --win --x64
# 本脚本只负责把已有产物收拢进来；缺哪个就跳过哪个并提示。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/iml-work-admin/admin-backend"
FRONTEND="$ROOT/iml-work-admin/admin-frontend"
CLIENT="$ROOT/iml-work-client"
OUT="$ROOT/dist/release"
VERSION=$(node -p "require('$CLIENT/package.json').version")
STAGE="$OUT/iml-work-server-$VERSION"

echo "═══ iML Work Release v$VERSION ═══"

# ── ① 后端部署包（复用 package-backend.sh，它会 mvn clean package）──────────
echo ""
echo "① 后端 jar"
bash "$ROOT/scripts/package-backend.sh" >/dev/null
[ -f "$ROOT/dist/backend/admin-backend.jar" ] || { echo "✗ 后端打包失败"; exit 1; }
echo "   ✓ admin-backend.jar ($(du -h "$ROOT/dist/backend/admin-backend.jar" | cut -f1))"

# ── ② 管理前端静态包 ────────────────────────────────────────────────────────
echo ""
echo "② 管理前端"
(cd "$FRONTEND" && npm run build >/dev/null 2>&1)
[ -f "$FRONTEND/dist/index.html" ] || { echo "✗ 前端构建失败"; exit 1; }
echo "   ✓ admin-frontend ($(du -sh "$FRONTEND/dist" | cut -f1))"

# ── ③ 组装服务端一体包 ──────────────────────────────────────────────────────
echo ""
echo "③ 组装服务端一体包"
rm -rf "$STAGE"; mkdir -p "$STAGE"

cp -r "$ROOT/dist/backend/." "$STAGE/"                    # jar + config 模板 + start.sh + 两份文档
cp -r "$FRONTEND/dist" "$STAGE/admin-frontend"            # 前端静态文件
cp "$BACKEND/deploy/install.sh" "$STAGE/install.sh"
cp "$BACKEND/deploy/nginx.conf.example" "$STAGE/nginx.conf.example"
cp "$ROOT/scripts/docker-services.sh" "$STAGE/docker-services.sh"
chmod +x "$STAGE/install.sh" "$STAGE/start.sh" "$STAGE/docker-services.sh"

# docker-services.sh 在仓库里按相对路径找沙箱镜像的构建上下文，发布包里要把它带上
mkdir -p "$STAGE/docker"
cp -r "$BACKEND/docker/sandbox" "$STAGE/docker/sandbox" 2>/dev/null || true
cp -r "$BACKEND/docker/searxng" "$STAGE/docker/searxng" 2>/dev/null || true
rm -rf "$STAGE/docker/sandbox/wheels" "$STAGE/docker/sandbox/fonts"   # 大二进制/版权字体不进包
mkdir -p "$STAGE/docker/sandbox/wheels" "$STAGE/docker/sandbox/fonts"
touch "$STAGE/docker/sandbox/wheels/.gitkeep" "$STAGE/docker/sandbox/fonts/.gitkeep"

cp "$BACKEND/deploy/INSTALL.md" "$STAGE/INSTALL.md" 2>/dev/null || true

(cd "$OUT" && tar -czf "iml-work-server-$VERSION.tar.gz" "iml-work-server-$VERSION")
rm -rf "$STAGE"
echo "   ✓ iml-work-server-$VERSION.tar.gz ($(du -h "$OUT/iml-work-server-$VERSION.tar.gz" | cut -f1))"

# ── ④ 收拢客户端安装包 ──────────────────────────────────────────────────────
echo ""
echo "④ 客户端安装包"
for f in "iML-Work-$VERSION-mac-arm64.dmg" "iML-Work-$VERSION-mac-x64.dmg" "iML-Work-$VERSION-win-x64.exe"; do
  if [ -f "$CLIENT/release/$f" ]; then
    cp "$CLIENT/release/$f" "$OUT/$f"
    echo "   ✓ $f ($(du -h "$OUT/$f" | cut -f1))"
  else
    echo "   ⚠ 缺 $f —— 先在 $CLIENT 跑 electron-builder"
  fi
done

# ── ⑤ 校验和 ────────────────────────────────────────────────────────────────
echo ""
echo "⑤ 校验和"
(cd "$OUT" && shasum -a 256 iml-work-server-*.tar.gz iML-Work-*.dmg iML-Work-*.exe 2>/dev/null > SHA256SUMS.txt)
echo "   ✓ SHA256SUMS.txt"

echo ""
echo "═══ 完成 → $OUT ═══"
ls -lh "$OUT" | tail -n +2 | awk '{printf "   %-46s %s\n", $9, $5}'
