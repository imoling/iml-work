# iML 代码执行沙箱基础镜像：在 python:3.12-slim 上预装常用办公/数据包，
# 免去每次执行容器内 pip 联网安装（提速 + 省网 + 可开网络隔离）。
#
# 推荐经一键脚本构建（会先备好本地离线包）：
#   bash scripts/docker-services.sh build
# 或直接：
#   docker build -t iml-sandbox:py312 iml-work-admin/admin-backend/docker/sandbox
#
# 预装包版本锁在 requirements.txt；wheels/ 是本地离线包目录（.gitignore 排除）：
#   · wheels/ 有 .whl → 离线装（--no-index），断网也能 build；
#   · wheels/ 为空   → 联网装（走 build 环境代理）。
FROM python:3.12-slim

# 中文字体：pillow/matplotlib 渲染中文必需，否则中文全变方框(□)。
# 文泉驿(wqy)轻量字体（zenhei 黑体 + microhei 无衬线，适合海报/图表），fontconfig 便于按名解析。
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-wqy-zenhei \
      fonts-wqy-microhei \
      fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

# 预装包：优先用本地离线 wheels，缺则联网装（版本均锁在 requirements.txt）。
COPY requirements.txt /tmp/requirements.txt
COPY wheels/ /tmp/wheels/
RUN if ls /tmp/wheels/*.whl >/dev/null 2>&1; then \
      echo "[sandbox] 用本地离线 wheels 装（--no-index）" && \
      pip install --no-cache-dir --no-index --find-links=/tmp/wheels -r /tmp/requirements.txt; \
    else \
      echo "[sandbox] wheels 为空，联网装" && \
      pip install --no-cache-dir -r /tmp/requirements.txt; \
    fi \
    && rm -rf /tmp/wheels /tmp/requirements.txt

# 预留工作目录（wrapper 脚本会 mkdir /out /work/out）
WORKDIR /work
