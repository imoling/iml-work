# iML Work 后端 · 部署包说明

`bash scripts/package-backend.sh` 打出的部署包结构（落在 `dist/backend/`）：

```
dist/backend/
├── admin-backend.jar              # 可执行 fat jar（Spring Boot）
├── config/
│   └── application.yml.example    # 外置配置模板 → 复制成 application.yml 填写
├── start.sh                       # 启动脚本（自动加载 ./config/application.yml）
└── README.md                      # 本文件
```

配置**放在 jar 外**（`config/application.yml`），改配置不用重新打包——这是本部署包的核心。

---

## 配置分两层（务必分清）

### ① 启动前必填 —— 写在 `config/application.yml`

纯启动配置，管理平台改不了，缺/弱会拒启动（prod）：

| 项 | 说明 |
|---|---|
| `spring.datasource.*` | PostgreSQL(pgvector) 连接地址 / 账号 / 密码 |
| `security.jwt.secret` | JWT 签名密钥，≥32 字节随机串 |
| `security.confirm.hmac-secret` | 写操作确认令牌 HMAC 密钥 |
| `security.initial-admin-password` | 首次建库的超管口令（勿用 admin123） |
| `cors.allowed-origins` | 允许的管理前端域名 |
| `spring.profiles.active: prod` | 触发上面密钥的强校验 |

生成随机密钥：`openssl rand -base64 48`

### ② 部署后在管理平台页面配 —— 存数据库、运行时可改

**不要**指望在 `application.yml` 里配这些（那里只是首次兜底，改了对已建库无效）：

| 配置 | 在哪配 |
|---|---|
| docling 解析引擎端点 / OCR / 超时 | 管理端「知识库管理 › 解析引擎」页 |
| 沙箱 Docker 端点 / CPU / 内存 / 镜像 / 网络隔离 | 管理端「沙箱管理」页 |
| 模型提供商 / 上游地址 / key | 管理端模型提供商页 |

---

## 部署步骤

```bash
cd dist/backend

# 1. 准备外置配置
cp config/application.yml.example config/application.yml
vi config/application.yml          # 填「① 启动前必填」各项

# 2. 确保依赖就绪
#    · PostgreSQL(pgvector) 已起，且 config 里的 DB 连接可达（库/pgvector 扩展见 RUNBOOK）
#    · Java 21： java -version
#    · （可选）docling / 沙箱 Docker：见项目 scripts/docker-services.sh

# 3. 启动（前台；Flyway 自动迁移建表，首次建超管 admin）
./start.sh
```

首次启动后，登录管理端用 `admin` + 你填的 `initial-admin-password`，再去各页面配置 ② 类项。

### 后台常驻 / systemd（可选）

```ini
# /etc/systemd/system/iml-backend.service
[Unit]
Description=iML Work Admin Backend
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/iml/backend
ExecStart=/opt/iml/backend/start.sh
Environment=JAVA_OPTS=-Xmx2g
Restart=on-failure
User=iml

[Install]
WantedBy=multi-user.target
```

密钥不想写进 `application.yml` 时，可改用环境变量注入（`Environment=SECURITY_JWT_SECRET=...`），Spring relaxed binding 会覆盖同名配置。
