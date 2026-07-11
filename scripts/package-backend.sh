#!/usr/bin/env bash
# 打包后端为可部署包：mvn package → 组装 dist/backend/（jar + 外置 config 模板 + start.sh + README）。
# 配置放包外（config/application.yml），改配置不用重打包。部署说明见 dist/backend/README.md。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/iml-work-admin/admin-backend"
DEPLOY_SRC="$BACKEND/deploy"
OUT="$ROOT/dist/backend"

# Java 21（同 dev.sh）
if [ -d /opt/homebrew/opt/openjdk@21 ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@21
  export PATH="$JAVA_HOME/bin:$PATH"
fi

echo "① mvn 打包（clean package，跳测试）→ $BACKEND/target ..."
(cd "$BACKEND" && mvn -ntp -q clean package -DskipTests)

# spring-boot repackage 后的可执行 jar（排除 .original / sources / javadoc）
JAR=$(ls "$BACKEND"/target/admin-backend-*.jar 2>/dev/null | grep -vE "sources|original|javadoc" | head -1)
[ -f "$JAR" ] || { echo "✗ 未找到可执行 jar，打包可能失败。"; exit 1; }

echo "② 组装部署目录 → $OUT ..."
rm -rf "$OUT"
mkdir -p "$OUT/config"
cp "$JAR" "$OUT/admin-backend.jar"
cp "$DEPLOY_SRC/start.sh" "$OUT/start.sh" && chmod +x "$OUT/start.sh"
cp "$DEPLOY_SRC/application.yml.example" "$OUT/config/application.yml.example"
cp "$DEPLOY_SRC/README.md" "$OUT/README.md"
cp "$DEPLOY_SRC/DEPLOY-offline-linux.md" "$OUT/DEPLOY-offline-linux.md"

echo ""
echo "✅ 部署包就绪：${OUT}（约 $(du -sh "$OUT" 2>/dev/null | cut -f1)）"
echo "   ├ admin-backend.jar   ($(du -h "$OUT/admin-backend.jar" | cut -f1))"
echo "   ├ config/application.yml.example   ← cp 成 application.yml 填「① 启动前必填」"
echo "   ├ start.sh"
echo "   └ README.md"
echo ""
echo "部署： cd $OUT && cp config/application.yml.example config/application.yml && vi config/application.yml && ./start.sh"
