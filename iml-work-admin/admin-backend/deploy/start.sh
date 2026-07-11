#!/usr/bin/env bash
# iML Work 后端启动脚本（部署包内）。
# 外置配置 ./config/application.yml 会自动覆盖 jar 内默认（Spring Boot 约定）。
set -euo pipefail
cd "$(dirname "$0")"

# Java 21（Homebrew openjdk@21 优先；服务器上请自行确保 java -version 为 21）
if [ -d /opt/homebrew/opt/openjdk@21 ]; then export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"; fi

if [ ! -f config/application.yml ]; then
  echo "✗ 缺 config/application.yml"
  echo "  先执行： cp config/application.yml.example config/application.yml"
  echo "  再填写其中「① 启动前必填」各项（DB 连接 / 密钥 / CORS）。"
  exit 1
fi

# 密钥也可用环境变量注入（覆盖 application.yml，适合 CI/K8s Secret）。Spring relaxed binding：
#   export SECURITY_JWT_SECRET=...  SECURITY_CONFIRM_HMAC_SECRET=...  DB_PASSWORD=...
# JVM 参数经 JAVA_OPTS 注入（默认 -Xmx1g）。
exec java ${JAVA_OPTS:--Xmx1g} -jar admin-backend.jar
