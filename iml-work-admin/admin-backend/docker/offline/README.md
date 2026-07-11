# 离线镜像制品（docker save 的 tar）

部署环境无法联网拉镜像 / build 时，把本目录的 `*.tar` 拷到部署机 `docker load` 即可——**免联网、免 build，直接可用**。

| 文件 | 内容 | 大小(约) |
|---|---|---|
| `iml-sandbox-py312.tar` | 代码执行沙箱镜像 `iml-sandbox:py312`（预装 python-docx/openpyxl/pandas/pillow/python-pptx/PyPDF2/matplotlib + 中文字体） | 190M |
| `docling-serve.tar` | 文档解析 `ghcr.io/docling-project/docling-serve`（含 OCR/ML 依赖） | 数 GB |

`*.tar` 太大**不进 git**（见根 `.gitignore`），只保留本 README。沙箱另有更小的离线制品：`../sandbox/wheels/`（wheel 包，供离线 build）。

## 导出（开发机，制作离线包）

```bash
bash scripts/docker-services.sh save-images    # docker save 沙箱 + docling → 本目录 *.tar
```

## 导入（部署机，离线加载）

```bash
bash scripts/docker-services.sh load-images    # 从本目录 *.tar docker load
# 或手动：
#   docker load -i iml-sandbox-py312.tar
#   docker load -i docling-serve.tar
```

load 后：沙箱镜像即 `iml-sandbox:py312`（管理端「沙箱管理」页基础镜像填它）；docling 用 `bash scripts/docker-services.sh up` 起容器（compose 会用已 load 的本地镜像，不再联网拉）。
