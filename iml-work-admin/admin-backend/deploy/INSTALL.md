# iML Work 私有化部署

这个包是自包含的——不用克隆代码仓，解压就能装。

```
iml-work-server-<版本>/
├── install.sh                  一键安装（起库 → 生成密钥 → 写配置 → 启动后端）
├── admin-backend.jar           管理后端（Spring Boot 可执行 jar）
├── admin-frontend/             管理前端静态文件（交给 nginx）
├── nginx.conf.example          nginx 配置模板
├── docker-services.sh          配套服务：文档解析 / 向量模型 / 代码沙箱 / 自托管检索
├── MIDDLEWARE.md               中间件镜像准备（拉取 / 离线 tar 导出导入命令）
├── docker/                     四件套的镜像构建上下文与离线 tar 存放目录
├── config/application.yml.example   手工部署时的配置模板
├── start.sh                    单独启停后端用
├── README.md                   配置项详解（哪些填 yml、哪些在页面配）
└── DEPLOY-offline-linux.md     无外网服务器的离线部署步骤
```

## 前置

| 依赖 | 版本 | 说明 |
|---|---|---|
| Java | 21+ | `apt install openjdk-21-jre` / `yum install java-21-openjdk` |
| Docker | 20+ | 数据库、沙箱、文档解析、向量模型都跑在容器里 |
| nginx | 任意 | 托管管理前端并反代 `/api` |
| 内存 | ≥8G | 后端 1G + PG 1G + 向量模型 2G + 沙箱按需 |

## 三步装完

### 1. 后端 + 数据库

```bash
tar -xzf iml-work-server-<版本>.tar.gz && cd iml-work-server-<版本>
./install.sh
```

脚本会做完这些：查环境 → 起 `pgvector/pgvector:pg17` 容器并建 vector 扩展 → 生成随机 JWT/HMAC 密钥
→ 写 `config/application.yml` → 启动后端（Flyway 建表 + 播种 9 个预置技能）。

全自动装法：`ADMIN_PASSWORD='你的口令' ./install.sh --yes`

脚本是幂等的：配置已存在就跳过，数据库容器已存在就复用，不会覆盖你的数据。

### 2. 管理前端

```bash
sudo mkdir -p /opt/iml && sudo cp -r admin-frontend /opt/iml/
sudo cp nginx.conf.example /etc/nginx/conf.d/imlwork.conf
sudo vi /etc/nginx/conf.d/imlwork.conf     # 改 3 处「改我」：域名、静态目录、后端地址
sudo nginx -t && sudo nginx -s reload
```

> 前端所有请求打自己的 `/api`（同源相对路径）。**必须由同一个 nginx 同时托管静态文件并反代 `/api` 到 8080**；
> 前后端拆成两个域名会跨域，还得额外配 `cors.allowed-origins`，不建议。

浏览器打开你配的域名，用 `admin` + 安装时设的口令登录。

### 3. 配套服务

```bash
./docker-services.sh up
```

拉起四个：文档解析（docling）、向量模型（Ollama + bge-m3）、代码沙箱镜像、自托管检索（SearXNG）。
这四个都是现成开源镜像，没打进发布包——拉取命令、按需取舍、离线 tar 导出导入见 **`MIDDLEWARE.md`**。

> ⚠️ **向量模型缺失时系统不报错**，检索会静默退化成字面匹配、知识库形同虚设。装完务必去管理端「知识中心」传一个文档、搜一下，确认命中的是语义结果。

无外网的服务器走离线方案：镜像在有网机器上 `docker save` 成 tar 拷过去 `load`，步骤见 `DEPLOY-offline-linux.md`。**镜像 tar 分架构**，arm64 的包放到 x86_64 机器上会直接 `exec format error`，备制品前先在目标机跑 `uname -m`。

## 装完是一个干净环境

服务端跑在 `prod` profile 下，**不播种任何演示数据**——没有示例岗位、没有假知识库文档、没有假业务系统、没有企业档案、没有模型通道，审计追溯与运行总览都是空的。你从第一条真实记录开始积累。

唯一预置的是 **9 个内置技能**（深度调研 / A股分析 / docx·pptx·xlsx·pdf / 图片视频生成 / skill-creator）——那是产品能力底盘，不是假业务数据。

首次登录后按顺序配（都在管理端页面里，不用改配置文件）：

1. **模型网关** — 登记至少一个标准档通道，否则分身没法思考
2. **企业信息** — 公司名与制度信息，分身答题时会用
3. **知识中心** — 传企业文档入库
4. **岗位专家** — 建岗位、装技能
5. **业务系统** — 登记 OA / CRM 地址（只记地址与可达状态，**不收密码**）
6. **安全沙箱** — 确认沙箱镜像已就绪

## 员工客户端

发给员工装：

| 文件 | 装在哪 |
|---|---|
| `iML-Work-<版本>-mac-arm64.dmg` | Apple Silicon Mac |
| `iML-Work-<版本>-mac-x64.dmg` | Intel Mac |
| `iML-Work-<版本>-win-x64.exe` | Windows 10/11 x64 |

安装包未做代码签名，首次打开要放行：macOS「系统设置 › 隐私与安全性 › 仍要打开」；Windows「更多信息 › 仍要运行」。

客户端首次启动要填**服务端地址**（就是上面 nginx 那个域名），然后用管理端建的员工账号登录。凭证与业务数据只在员工本机，不上传。

## 升级

```bash
# 停旧后端
kill $(pgrep -f admin-backend.jar)
# 换 jar 与前端，配置和数据库都不动
cp 新包/admin-backend.jar .
sudo cp -r 新包/admin-frontend /opt/iml/
./start.sh
```

Flyway 会自动补迁移。`config/application.yml` 和数据库不受影响。

## 排查

| 现象 | 查这里 |
|---|---|
| 后端起不来 | `logs/backend.log`；prod 下密钥缺或太弱会**故意**拒启动 |
| 页面能开但接口 502 | nginx `proxy_pass` 指的后端地址不对，或后端没起 |
| 长任务跑一半断 | nginx `proxy_read_timeout` 调大（模板里已设 600s） |
| 知识库搜不准 | 向量模型没起——`docker ps` 看 ollama，管理端「知识中心」重建索引 |
| 沙箱技能跑不了 | `docker images` 看沙箱镜像在不在，管理端「安全沙箱」页核对端点 |
