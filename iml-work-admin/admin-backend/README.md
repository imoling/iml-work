# iML Work Admin Backend

Spring Boot 3.3 / Java 21 运营管理后端，提供岗位专家、SkillsHub 技能中心、企业知识库（PostgreSQL + pgvector 真实向量检索）、沙箱容器监控（docker-java）、外部系统集成与运营监控仪表盘等 REST API。

## 真实基础设施

| 组件 | 用途 | 依赖 |
| :--- | :--- | :--- |
| PostgreSQL + pgvector | 数据持久化 + 知识库向量检索 | `docker-compose.yml` 一键拉起 |
| docker-java | 沙箱容器实时监控与强杀 | 可选，未连接时优雅降级 |
| 向量嵌入 | RAG embedding | 默认本地 feature-hashing；可配置远程 TEI/OpenAI 兼容 `/embeddings` |

## 本地运行

```bash
# 1. 启动 PostgreSQL + pgvector（账号/库名见 application.yml 默认值）
cd src/main/resources && docker compose up -d && cd -

# 2. 启动后端（首次启动自动建表、装载 pgvector 扩展并 seed 演示数据）
mvn spring-boot:run
# 或
mvn package -DskipTests && java -jar target/admin-backend-1.0.0-SNAPSHOT.jar
```

服务端口 `8080`。前端 `admin-frontend` 通过 Vite 代理 `/api` → `:8080`。

### 备选：Homebrew 启动（macOS 无 Docker，已实测通过）

```bash
# 1. 安装 postgresql + pgvector + JDK21
brew install postgresql@17 pgvector openjdk@21

# 2. 启动 Postgres 并创建 imlwork 角色/库
PGBIN=/opt/homebrew/opt/postgresql@17/bin
$PGBIN/pg_ctl -D /opt/homebrew/var/postgresql@17 -l /tmp/imlwork_pg.log start
$PGBIN/psql -d postgres -c "CREATE ROLE imlwork WITH LOGIN SUPERUSER PASSWORD 'imlwork';"
$PGBIN/psql -d postgres -c "CREATE DATABASE imlwork OWNER imlwork;"
# (CREATE EXTENSION vector 由后端 schema.sql 在首次启动时自动执行)

# 3. 用 JDK21 启动后端（Spring Boot 3.3 在 JDK 25+ 运行时存在兼容风险，固定用 21）
cd iml-work-admin/admin-backend
JAVA_HOME=/opt/homebrew/opt/openjdk@21 mvn spring-boot:run
```

> 验证状态：上述路径已在 PostgreSQL 17 + pgvector 0.8.2 上端到端实测通过 —— 6 大模块 REST 端点全部返回真实数据，pgvector 384 维向量检索、检索命中率审计、技能 frontmatter 解析、集成状态机、Docker 无守护进程优雅降级均工作正常。

> 依赖说明：Docker 监控仅依赖 `docker-java-core` + `docker-java-transport-httpclient5`（不要引入 umbrella `docker-java` 包，它会带入 Jersey 传输层的 `jackson-module-jaxb-annotations`(legacy javax.xml.bind)，破坏 Hibernate 的 JSON format-mapper 解析）。

## 可配置环境变量

| 变量 | 说明 | 默认 |
| :--- | :--- | :--- |
| `DB_URL` / `DB_USER` / `DB_PASSWORD` | 数据库连接 | `jdbc:postgresql://localhost:5432/imlwork` / `imlwork` / `imlwork` |
| `EMBED_ENDPOINT` / `EMBED_API_KEY` / `EMBED_MODEL` | 远程嵌入模型（留空则本地向量化） | 空 / 空 / `bge-large-zh-v1.5` |
| `DOCKER_HOST` | Docker Remote API 端点 | `unix:///var/run/docker.sock` |
| `MODEL_API_KEY` / `MODEL_TARGET_URL` | 大模型中转网关上游 | 空 / DeepSeek |

> 嵌入向量维度固定为 384（匹配 `schema.sql` 的 `vector(384)`）。如接入输出维度不同的远程模型，请同步调整 `schema.sql` 与 `rag.embedding.dimension`。

## REST API 概览

- `GET/POST/PUT/DELETE /api/v1/experts` · `POST /api/v1/experts/claim/{id}` — 专家 CRUD + 领用（下发技能与知识库检索范围）
- `GET/POST/PUT/DELETE /api/v1/skills` · `POST /api/v1/skills/upload`（.md/.zip）· `POST /api/v1/skills/{id}/test` — SkillsHub
- `GET /api/v1/knowledge/docs` · `POST /upload`（chunkSize/overlap）· `GET /query` · `GET /audit` — 知识库 + 检索命中率审计
- `GET/PUT /api/v1/sandbox/config` · `POST /docker/ping` · `GET /containers` · `DELETE /containers/{id}` — 沙箱配置与容器监控
- `GET/POST/PUT/DELETE /api/v1/integrations` · `POST /{id}/verify|disconnect` — 外部系统集成
- `GET /api/v1/dashboard/overview|timeseries` — 运营仪表盘
- `POST /api/v1/model/chat` · `GET /stats` — 统一模型中转网关（DLP 脱敏）
