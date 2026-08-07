# 中间件镜像准备

Release 里只有后端和客户端安装包。四个中间件都是现成的开源镜像，太大不适合放 Release，
自己拉一次即可——有外网的机器直接拉，内网机器走离线 tar。

## 清单

| 用途 | 镜像 | 大小 | 少了会怎样 |
|---|---|---|---|
| 数据库 | `pgvector/pgvector:pg17` | ~400M | **必需**，后端起不来 |
| 向量模型 | `ollama/ollama:latest` + `bge-m3` 权重 | ~600M + 1.2G | **静默降级**：检索退化成字面匹配，知识库形同虚设且不报错 |
| 文档解析 | `ghcr.io/docling-project/docling-serve` | ~5G | 上传文档无法入库 |
| 代码沙箱 | `iml-sandbox:py312`（本地 build） | ~1.5G | 文档生成/数据分析类技能跑不了 |
| 自托管检索 | `searxng/searxng:latest` | ~300M | 联网检索不可用（也可改配商业检索 API） |

按需取：只用文档处理就不需要 searxng；不做知识库就不需要 docling 和向量模型。**数据库是唯一硬依赖。**

## 有外网：直接拉

```bash
docker pull pgvector/pgvector:pg17
docker pull ollama/ollama:latest
docker pull ghcr.io/docling-project/docling-serve
docker pull searxng/searxng:latest
```

沙箱镜像要本地 build（装了受限的 Python 包白名单）：

```bash
./docker-services.sh build          # 用包内 docker/sandbox/ 上下文
```

一把起全部：

```bash
./docker-services.sh up             # 起容器 + 拉 bge-m3 模型权重
./docker-services.sh status         # 看谁起来了
```

> ghcr.io 拉不动时换镜像源：`ghcr.m.daocloud.io/docling-project/docling-serve`，
> 拉完 `docker tag` 回原名，`docker-services.sh` 才认得。

## 无外网：导出 tar 拷过去

在有网的机器上把镜像存成 tar（这就是你放云盘的那一份）：

```bash
docker save pgvector/pgvector:pg17            -o pgvector-pg17.tar
docker save ollama/ollama:latest              -o ollama.tar
docker save ghcr.io/docling-project/docling-serve -o docling-serve.tar
docker save searxng/searxng:latest            -o searxng.tar
docker save iml-sandbox:py312                 -o iml-sandbox-py312.tar
```

⚠️ **ollama 镜像里不含模型权重**（权重在命名卷里）。只搬镜像的话，内网机起来是个空壳，
后端调 `/v1/embeddings` 直接 `model_not_found`，然后**静默退回哈希兜底向量**——检索质量崩掉却不报错。
权重要单独导：

```bash
docker run --rm -v iml-ollama-models:/m -v "$PWD":/out alpine \
  tar cf /out/ollama-models.tar -C /m .        # 约 1.2G
```

包内脚本把上面这些打包成了一条命令（产物落 `docker/offline/`）：

```bash
./docker-services.sh save-images
```

拷到目标机后：

```bash
./docker-services.sh load-images     # 读 docker/offline/*.tar，含模型权重还原
./docker-services.sh up
```

⚠️ **镜像 tar 分架构**。arm64 上 save 的包放到 x86_64 服务器会直接 `exec format error`。
备制品前先在目标机跑 `uname -m`，按目标架构在同架构机器上拉取导出。

## 装完必须验一次

向量模型这条链路坏了不会报错，只会让检索悄悄变差。所以装完务必实测：

```bash
curl -s http://127.0.0.1:8080/api/v1/knowledge/embedding/health
```

再去管理端「知识中心」传一个文档、搜一个只在文中出现过的说法——命中的应该是语义结果，
不是字面命中。这一步不做，知识库很可能一直是废的而你不知道。
