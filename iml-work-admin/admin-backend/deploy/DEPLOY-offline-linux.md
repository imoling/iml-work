# iML Work 后端 · 无网 Linux 服务器离线部署手册

面向**不能联网的 Linux 服务器**。分两阶段：**A. 有网机器上准备离线制品** → 拷贝到服务器 → **B. 无网服务器上安装**（从创建目录开始）。

---

## 0. 先读：架构必须匹配

Docker 镜像和 JDK 是**分架构**的，准备制品的机器架构必须与目标服务器一致（后端 jar 是 Java 字节码，跨平台不受影响）。

```bash
uname -m        # 在【目标服务器】上执行
#   x86_64  → amd64（绝大多数云服务器 / Intel/AMD）
#   aarch64 → arm64（鲲鹏 / 部分 ARM 云 / Apple 芯片）
```

> ⚠️ 本项目当前在 macOS(arm64) 备的镜像 tar 是 **linux/arm64**。若目标服务器是 **amd64**，需在一台**有网的 amd64 机器**上重新执行「阶段 A」的镜像准备（`docker save` 出 amd64 版），否则镜像 load 后无法运行。JDK 也按目标架构下载。

三样东西按架构选：**① Docker 镜像 tar、② JDK、③（若走离线 build）沙箱 wheel**。本手册走「镜像 tar 直接 load」路线，不在服务器上 build，所以不需要 wheel。

---

## 阶段 A：有网机器上准备离线制品

在一台**能联网、且架构与目标服务器相同**的机器上，产出一个可拷贝的 `iml-deploy/` 目录。

### A1. 打后端包

```bash
cd <项目根>
bash scripts/package-backend.sh          # 产出 dist/backend/（jar + config 模板 + start.sh + README）
```

### A2. 备齐 Docker 镜像 tar

```bash
# 沙箱 + docling（先确保本地有这两个镜像：build 沙箱、拉 docling）
bash scripts/docker-services.sh up          # colima/docker 起 + 沙箱 build + docling 拉取
bash scripts/docker-services.sh save-images # → docker/offline/{iml-sandbox-py312.tar, docling-serve.tar}

# PostgreSQL（pgvector）镜像
docker pull pgvector/pgvector:pg16
docker save pgvector/pgvector:pg16 -o iml-work-admin/admin-backend/docker/offline/pgvector-pg16.tar
```

### A3. 下载 JDK 21（按目标架构）

从 Adoptium Temurin 下 **JDK 21** 的 Linux tar.gz：
- amd64： `OpenJDK21U-jdk_x64_linux_hotspot_*.tar.gz`
- arm64： `OpenJDK21U-jdk_aarch64_linux_hotspot_*.tar.gz`

（下载页 https://adoptium.net/temurin/releases/?version=21 ，放进下面的 `iml-deploy/`。）

### A4. 汇总成一个可拷贝目录

```bash
cd <项目根>
mkdir -p iml-deploy/images
cp -r dist/backend                         iml-deploy/backend
cp iml-work-admin/admin-backend/docker/offline/*.tar   iml-deploy/images/
cp OpenJDK21U-jdk_*_linux_hotspot_*.tar.gz iml-deploy/jdk21.tar.gz
# 结果：
#   iml-deploy/
#   ├── backend/            后端包（jar + config + start.sh + README）
#   ├── images/             pgvector-pg16.tar / iml-sandbox-py312.tar / docling-serve.tar
#   └── jdk21.tar.gz        JDK 21（目标架构）
tar czf iml-deploy.tar.gz iml-deploy      # 打成一个包，拷到服务器
```

把 `iml-deploy.tar.gz` 用 U 盘 / scp / 内网传到目标服务器。

---

## 阶段 B：无网 Linux 服务器上部署（从创建目录开始）

假设服务器已装 **Docker + docker compose**（用来跑 PostgreSQL / 沙箱 / docling）。若连 Docker 都没有，见文末「B0 离线装 Docker」。

### B1. 确认环境 + 解包

```bash
uname -m                                   # 再次确认架构与制品一致
docker --version && docker compose version # 确认 docker 可用

# 解开传来的包（假设放在 ~ ）
cd ~ && tar xzf iml-deploy.tar.gz
```

### B2. 创建部署目录结构

```bash
sudo mkdir -p /opt/iml/{backend,jdk,pgdata}
sudo chown -R "$USER":"$USER" /opt/iml
# /opt/iml
# ├── backend/   后端 jar + config
# ├── jdk/       JDK 21
# └── pgdata/    PostgreSQL 数据（持久化卷）
```

### B3. 安装 JDK 21（解压即用）

```bash
tar xzf ~/iml-deploy/jdk21.tar.gz -C /opt/iml/jdk --strip-components=1
export JAVA_HOME=/opt/iml/jdk
export PATH="$JAVA_HOME/bin:$PATH"
java -version                              # 应显示 21.x
```

### B4. 起 PostgreSQL（pgvector）

```bash
# 载入镜像（离线）
docker load -i ~/iml-deploy/images/pgvector-pg16.tar

# 起容器：自动建库 imlwork / 角色 imlwork，数据落 /opt/iml/pgdata
docker run -d --name imlwork-pg \
  -e POSTGRES_DB=imlwork \
  -e POSTGRES_USER=imlwork \
  -e POSTGRES_PASSWORD='改我-数据库密码' \
  -p 127.0.0.1:5432:5432 \
  -v /opt/iml/pgdata:/var/lib/postgresql/data \
  --restart unless-stopped \
  pgvector/pgvector:pg16

# 等就绪
until docker exec imlwork-pg pg_isready -U imlwork >/dev/null 2>&1; do sleep 1; done
echo "PostgreSQL 就绪"
```

> pgvector 扩展和所有表由后端首启时的 **Flyway 自动创建**（V1 迁移含 `CREATE EXTENSION vector`），这里**无需手动建表**。

### B5. 部署后端

```bash
# 放 jar + 配置
cp -r ~/iml-deploy/backend/* /opt/iml/backend/
cd /opt/iml/backend

# 生成外置配置，填「① 启动前必填」
cp config/application.yml.example config/application.yml
vi config/application.yml
```

`config/application.yml` 至少改这些（**① 启动前必填**）：

```yaml
spring:
  profiles: { active: prod }               # prod：密钥弱/缺即拒启动
  datasource:
    url: jdbc:postgresql://127.0.0.1:5432/imlwork
    username: imlwork
    password: "改我-数据库密码"             # 与 B4 的 POSTGRES_PASSWORD 一致
security:
  jwt:            { secret: "改我-JWT密钥≥32字节" }      # openssl rand -base64 48
  confirm:        { hmac-secret: "改我-确认令牌HMAC密钥" }
  initial-admin-password: "改我-初始超管口令"            # 勿用 admin123
cors:
  allowed-origins: "https://你的管理前端域名"
```

> docling 端点、沙箱 Docker 端点/镜像、模型提供商**不在这里配**——它们是「② 管理平台页面配」，登录后在管理端页面设、存数据库。

启动（前台先验证；Flyway 自动迁移建表、首次建超管 admin）：

```bash
export JAVA_HOME=/opt/iml/jdk PATH="/opt/iml/jdk/bin:$PATH"
./start.sh
# 另开一窗验证：
curl -s -o /dev/null -w "backend %{http_code}\n" http://localhost:8080/v3/api-docs   # 200=就绪
```

浏览器访问管理前端，用 `admin` + 你填的 `initial-admin-password` 登录。

### B6. 后台常驻（systemd）

```bash
sudo tee /etc/systemd/system/iml-backend.service >/dev/null <<'EOF'
[Unit]
Description=iML Work Admin Backend
After=network.target docker.service

[Service]
WorkingDirectory=/opt/iml/backend
Environment=JAVA_HOME=/opt/iml/jdk
Environment=PATH=/opt/iml/jdk/bin:/usr/bin:/bin
Environment=JAVA_OPTS=-Xmx2g
ExecStart=/opt/iml/jdk/bin/java -Xmx2g -jar /opt/iml/backend/admin-backend.jar
Restart=on-failure
User=%i

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now iml-backend
sudo journalctl -u iml-backend -f          # 看日志
```

> 密钥不想写进 `application.yml` 时，可改用 `Environment=SECURITY_JWT_SECRET=...` 等注入（Spring relaxed binding 覆盖同名配置）。

### B7.（可选）沙箱 + docling 增强服务

后端核心不依赖这两个（缺则文档解析降级、代码执行不可用）。要启用：

```bash
# 载入镜像（离线）
docker load -i ~/iml-deploy/images/iml-sandbox-py312.tar
docker load -i ~/iml-deploy/images/docling-serve.tar

# 起 docling（:5001）
docker run -d --name iml-docling-serve -p 5001:5001 \
  -e LOAD_MODELS_AT_BOOT=false --restart unless-stopped \
  ghcr.io/docling-project/docling-serve
```

然后登录管理端配置（② 类，存 DB）：
- 「知识库管理 › 解析引擎」：端点填 `http://localhost:5001`，点「检测」。
- 「沙箱管理」：Docker 接口端点填 `unix:///var/run/docker.sock`（服务器本机 daemon），基础镜像填 `iml-sandbox:py312`，点「检测联通」/「测试执行」。

沙箱是一次性容器（用时创建→执行→销毁），只要镜像已 load + Docker 可达即可，无需常驻。

---

## 验证清单

```bash
docker ps --format '{{.Names}} {{.Status}}'                 # imlwork-pg / iml-docling-serve 在跑
curl -s -o /dev/null -w "backend %{http_code}\n" http://localhost:8080/v3/api-docs   # 200
sudo systemctl status iml-backend                          # active (running)
```

## 常见坑

- **`exec format error` / 镜像跑不起来**：镜像架构 ≠ 服务器架构。回阶段 A 在同架构机器重做 `docker save`。
- **后端启动报 JWT/HMAC/口令 相关拒启动**：`spring.profiles.active=prod` 下这三个密钥必须显式配强值（见 B5）。
- **后端连不上库**：确认 `application.yml` 的 DB 密码 = B4 的 `POSTGRES_PASSWORD`；`docker exec imlwork-pg pg_isready -U imlwork`。
- **`column does not exist`**：不应发生（Flyway 建全表）；若手工改过库，检查 `flyway_schema_history` 表。

## B0. 服务器离线装 Docker（仅当服务器没有 Docker）

从 https://download.docker.com/linux/static/stable/<arch>/ 下 `docker-<ver>.tgz`（arch 为 x86_64 或 aarch64），有网机下好拷过去：

```bash
tar xzf docker-*.tgz
sudo cp docker/* /usr/bin/
sudo dockerd >/var/log/dockerd.log 2>&1 &     # 或配 systemd
```

不想用 Docker 跑 PostgreSQL 时，也可在服务器原生装 postgresql + 编译 pgvector 扩展，但离线依赖较多，推荐上面的镜像方案。
