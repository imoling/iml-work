# iML 代码执行沙箱基础镜像：在 python:3.12-slim 上预装常用办公/数据包，
# 免去每次执行容器内 pip 联网安装（提速 + 省网 + 可开网络隔离）。
#
# 构建（在配置的 Docker 主机 / 本机 colima 上）：
#   docker build -t iml-sandbox:py312 iml-work-admin/admin-backend/docker/sandbox
# 然后在管理端「沙箱监控」把「基础镜像」改为 iml-sandbox:py312。
FROM python:3.12-slim

# 中文字体：pillow/matplotlib 渲染中文必需，否则中文全变方框(□)。
# 文泉驿(wqy)轻量字体（zenhei 黑体 + microhei 无衬线，适合海报/图表），fontconfig 便于按名解析。
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-wqy-zenhei \
      fonts-wqy-microhei \
      fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

RUN pip install --no-cache-dir \
      python-docx \
      openpyxl \
      pandas \
      pillow \
      python-pptx \
      PyPDF2 \
      matplotlib

# 预留工作目录（wrapper 脚本会 mkdir /out /work/out）
WORKDIR /work
