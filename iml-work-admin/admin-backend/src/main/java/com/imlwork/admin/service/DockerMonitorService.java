package com.imlwork.admin.service;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.command.InspectContainerResponse;
import com.github.dockerjava.api.command.CreateContainerResponse;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Container;
import com.github.dockerjava.api.model.ExposedPort;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.Ports;
import com.github.dockerjava.api.model.RestartPolicy;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
import com.github.dockerjava.core.command.PullImageResultCallback;
import com.github.dockerjava.transport.DockerHttpClient;
import com.github.dockerjava.httpclient5.ApacheDockerHttpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Real sandbox container monitoring through the Docker Remote API (docker-java).
 * Every call degrades gracefully — when no docker daemon is reachable it returns
 * a structured {@code reachable:false} payload instead of throwing, so the admin
 * console stays responsive without a running daemon.
 */
@Service
public class DockerMonitorService {

    /** 与 SandboxExecService.SANDBOX_LABEL 同一个标签（一次性执行容器的身份标记）。 */
    private static final String SANDBOX_LABEL = "iml.sandbox";

    /** 常驻基础服务：容器名 → 人话角色。它们不是虾池，不参与「强杀」。 */
    private static final Map<String, String> BASE_SERVICES = Map.of(
            "iml-docling-serve", "文档引擎",
            "iml-embedding", "向量模型",
            "iml-searxng", "聚合检索");

    private static String firstName(Container c) {
        if (c.getNames() == null || c.getNames().length == 0) return "";
        String n = c.getNames()[0];
        return n.startsWith("/") ? n.substring(1) : n;
    }

    private static final Logger log = LoggerFactory.getLogger(DockerMonitorService.class);

    @Value("${sandbox.docker.host:unix:///var/run/docker.sock}")
    private String defaultHost;

    /** 沙箱配置（dockerEndpoint 的唯一来源，与 SandboxExecService 同一份）。 */
    private final SandboxConfigService configService;

    public DockerMonitorService(SandboxConfigService configService) {
        this.configService = configService;
    }

    private DockerClient buildClient(String host) {
        DockerClientConfig config = DefaultDockerClientConfig.createDefaultConfigBuilder()
                .withDockerHost(host)
                .build();
        DockerHttpClient httpClient = new ApacheDockerHttpClient.Builder()
                .dockerHost(config.getDockerHost())
                .sslConfig(config.getSSLConfig())
                .maxConnections(20)
                .connectionTimeout(Duration.ofSeconds(5))
                .responseTimeout(Duration.ofSeconds(10))
                .build();
        return DockerClientImpl.getInstance(config, httpClient);
    }

    /**
     * Docker 端点的**单一来源**：调用方显式指定 → 沙箱配置里存的 dockerEndpoint → yml 兜底。
     *
     * 曾经这里直接落 yml 默认值 unix:///var/run/docker.sock，而执行沙箱走的是库里配的
     * dockerEndpoint（本机是 colima 的 ~/.colima/default/docker.sock）——同一个 daemon 两份地址：
     * 代码照跑，监控页却报「无法连接 Docker 守护进程: No such file or directory」，因为那个路径压根不存在。
     */
    private String resolveHost(String host) {
        if (host != null && !host.isBlank()) return host;
        try {
            String configured = configService.getOrCreate().getDockerEndpoint();
            if (configured != null && !configured.isBlank()) return configured;
        } catch (Exception e) {
            log.warn("[Docker] 读取沙箱配置失败，回退 yml 默认端点：{}", e.getMessage());
        }
        return defaultHost;
    }

    /**
     * 把 docker-java / JNA 的底层异常翻成运维看得懂、且知道下一步干什么的话。
     * 原样甩 "com.sun.jna.LastErrorException: [2] No such file or directory" 到管理页，
     * 既吓人又没有任何可行动信息 —— 它其实只是「socket 文件不存在」，也就是 daemon 没起或地址填错了。
     */
    private static String friendlyError(String endpoint, Throwable t) {
        String raw = String.valueOf(t.getMessage());
        String cause;
        if (raw.contains("No such file or directory")) {
            cause = "该地址上没有 Docker 守护进程的 socket 文件（daemon 未启动，或地址填错了）。";
        } else if (raw.contains("Connection refused") || raw.contains("ConnectException")) {
            cause = "地址可达但拒绝连接（Docker 守护进程未在监听）。";
        } else if (raw.contains("Permission denied")) {
            cause = "无权访问该 socket（当前运行用户不在 docker 组内）。";
        } else if (raw.contains("timed out") || raw.contains("Timeout")) {
            cause = "连接超时（远程 Docker 主机不可达或被防火墙拦截）。";
        } else {
            cause = raw;
        }
        return "无法连接 Docker 守护进程（" + endpoint + "）：" + cause
                + " 排查：① 确认 Docker 已启动（本机用 colima 时执行 colima start）；"
                + "② 在「沙箱配置」核对 Docker 地址，colima 的地址通常是 unix:///Users/<用户名>/.colima/default/docker.sock，"
                + "而非 unix:///var/run/docker.sock。";
    }

    /** Ping the daemon to verify connectivity. */
    public Map<String, Object> ping(String host) {
        String target = resolveHost(host);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("endpoint", target);
        try (DockerClient client = buildClient(target)) {
            client.pingCmd().exec();
            String version = client.versionCmd().exec().getVersion();
            result.put("reachable", true);
            result.put("version", version);
            result.put("message", "Docker daemon reachable");
        } catch (Throwable t) {
            log.warn("[Docker] Ping failed for {}: {}", target, t.getMessage());
            result.put("reachable", false);
            result.put("message", friendlyError(target, t));
        }
        return result;
    }

    /** List sandbox containers, or a structured unreachable payload. */
    public Map<String, Object> listContainers(String host) {
        String target = resolveHost(host);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("endpoint", target);
        try (DockerClient client = buildClient(target)) {
            List<Container> containers = client.listContainersCmd().withShowAll(true).exec();
            // 分成两类，语义完全不同，绝不能混在一张表里：
            //   · 虾池容器 —— 一次性执行容器（跑完即焚），带 iml.sandbox 标签。可以强杀。
            //   · 基础服务 —— 常驻（文档引擎 / 向量模型）。**不该出现在「虾池容器监控」里**，
            //     更不该配「强杀」按钮 —— 一点就把整个知识库检索干掉了。
            List<Map<String, Object>> pool = new ArrayList<>();
            List<Map<String, Object>> services = new ArrayList<>();
            for (Container c : containers) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", c.getId());
                row.put("shortId", c.getId() != null && c.getId().length() > 12 ? c.getId().substring(0, 12) : c.getId());
                row.put("names", c.getNames());
                row.put("image", c.getImage());
                row.put("state", c.getState());
                row.put("status", c.getStatus());
                boolean labelled = c.getLabels() != null && c.getLabels().containsKey(SANDBOX_LABEL);
                String name = firstName(c);
                if (BASE_SERVICES.containsKey(name)) {
                    row.put("role", BASE_SERVICES.get(name));   // 人话名：文档引擎 / 向量模型
                    services.add(row);
                } else if (labelled) {
                    pool.add(row);
                }
                // 既非虾池、也非已知基础服务的容器（别的项目的）→ 不显示，与本平台无关
            }
            result.put("reachable", true);
            result.put("containers", pool);      // 虾池容器（一次性）
            result.put("services", services);    // 常驻基础服务
        } catch (Throwable t) {
            log.warn("[Docker] listContainers failed for {}: {}", target, t.getMessage());
            result.put("reachable", false);
            result.put("containers", new ArrayList<>());
            result.put("message", friendlyError(target, t));
        }
        return result;
    }

    // ── docling-serve 容器生命周期（拉镜像 / 建 / 启 / 停 / 重启）────────────
    // 与沙箱共用同一套 Docker Remote API。镜像拉取可能很慢，启动走后台线程，
    // 前端轮询 status 观察阶段（idle/pulling/starting/running/error）。

    // Daemon thread so a slow image pull never blocks JVM/Spring shutdown.
    private final ExecutorService lifecycleExec = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "docling-lifecycle");
        t.setDaemon(true);
        return t;
    });
    private volatile String doclingPhase = "idle";   // idle | pulling | starting | running | error
    private volatile String doclingMessage = "";

    public String getDoclingPhase() { return doclingPhase; }
    public String getDoclingMessage() { return doclingMessage; }

    /** Docker client with a long response timeout for slow ops (image pull). */
    private DockerClient buildLongClient(String host) {
        DockerClientConfig config = DefaultDockerClientConfig.createDefaultConfigBuilder()
                .withDockerHost(host)
                .build();
        DockerHttpClient httpClient = new ApacheDockerHttpClient.Builder()
                .dockerHost(config.getDockerHost())
                .sslConfig(config.getSSLConfig())
                .maxConnections(20)
                .connectionTimeout(Duration.ofSeconds(10))
                .responseTimeout(Duration.ofMinutes(30))
                .build();
        return DockerClientImpl.getInstance(config, httpClient);
    }

    private Container findByName(DockerClient client, String name) {
        String want = "/" + name;
        for (Container c : client.listContainersCmd().withShowAll(true).exec()) {
            if (c.getNames() != null) {
                for (String n : c.getNames()) {
                    if (n.equals(want) || n.equals(name)) return c;
                }
            }
        }
        return null;
    }

    /** Inspect the managed docling container by name; includes lifecycle phase. */
    public Map<String, Object> doclingContainerStatus(String host, String name) {
        String target = resolveHost(host);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("endpoint", target);
        result.put("phase", doclingPhase);
        result.put("phaseMessage", doclingMessage);
        try (DockerClient client = buildClient(target)) {
            Container c = findByName(client, name);
            if (c == null) {
                result.put("reachable", true);
                result.put("exists", false);
                return result;
            }
            result.put("reachable", true);
            result.put("exists", true);
            result.put("id", c.getId());
            result.put("state", c.getState());
            result.put("status", c.getStatus());
            result.put("image", c.getImage());
            result.put("running", "running".equalsIgnoreCase(c.getState()));
        } catch (Throwable t) {
            result.put("reachable", false);
            result.put("exists", false);
            result.put("message", friendlyError(target, t));
        }
        return result;
    }

    /** Start (creating/pulling as needed) the docling container. Runs async; poll status. */
    public synchronized Map<String, Object> startDocling(String host, String image, String name, int hostPort) {
        Map<String, Object> result = new LinkedHashMap<>();
        if ("pulling".equals(doclingPhase) || "starting".equals(doclingPhase)) {
            result.put("accepted", false);
            result.put("message", "正在进行中：" + doclingPhase);
            return result;
        }
        String target = resolveHost(host);
        doclingPhase = "starting";
        doclingMessage = "准备启动…";
        lifecycleExec.submit(() -> {
            try (DockerClient client = buildLongClient(target)) {
                Container existing = findByName(client, name);
                if (existing != null) {
                    if (!"running".equalsIgnoreCase(existing.getState())) {
                        doclingMessage = "启动已存在的容器…";
                        client.startContainerCmd(existing.getId()).exec();
                    }
                    doclingPhase = "running";
                    doclingMessage = "已启动";
                    return;
                }
                // Ensure image present, else pull (slow).
                try {
                    client.inspectImageCmd(image).exec();
                } catch (NotFoundException nf) {
                    doclingPhase = "pulling";
                    doclingMessage = "拉取镜像 " + image + " …";
                    client.pullImageCmd(image).exec(new PullImageResultCallback()).awaitCompletion();
                }
                doclingPhase = "starting";
                doclingMessage = "创建并启动容器…";
                ExposedPort ep = ExposedPort.tcp(5001);
                Ports bindings = new Ports();
                bindings.bind(ep, Ports.Binding.bindPort(hostPort));
                HostConfig hostConfig = HostConfig.newHostConfig()
                        .withPortBindings(bindings)
                        .withRestartPolicy(RestartPolicy.unlessStoppedRestart());
                CreateContainerResponse created = client.createContainerCmd(image)
                        .withName(name)
                        .withExposedPorts(ep)
                        .withHostConfig(hostConfig)
                        // 关闭启动预热，避免无 OCR 引擎时启动崩溃（解析时按需加载、do_ocr=false）
                        .withEnv("DOCLING_SERVE_LOAD_MODELS_AT_BOOT=false")
                        .exec();
                client.startContainerCmd(created.getId()).exec();
                doclingPhase = "running";
                doclingMessage = "已启动";
            } catch (Throwable t) {
                log.warn("[Docling] start container failed: {}", t.getMessage());
                doclingPhase = "error";
                doclingMessage = "启动失败：" + t.getMessage();
            }
        });
        result.put("accepted", true);
        result.put("message", "已提交启动，请稍候轮询状态");
        return result;
    }

    /** Stop the docling container (kept for fast restart). */
    public Map<String, Object> stopDocling(String host, String name, int timeoutSeconds) {
        String target = resolveHost(host);
        Map<String, Object> result = new LinkedHashMap<>();
        try (DockerClient client = buildClient(target)) {
            Container c = findByName(client, name);
            if (c == null) {
                result.put("success", true);
                result.put("message", "容器不存在（已是停止态）");
                doclingPhase = "idle";
                return result;
            }
            if ("running".equalsIgnoreCase(c.getState())) {
                client.stopContainerCmd(c.getId()).withTimeout(Math.max(1, timeoutSeconds)).exec();
            }
            doclingPhase = "idle";
            doclingMessage = "已停止";
            result.put("success", true);
            result.put("message", "容器已停止");
        } catch (Throwable t) {
            log.warn("[Docling] stop container failed: {}", t.getMessage());
            result.put("success", false);
            result.put("message", "停止失败：" + t.getMessage());
        }
        return result;
    }

    /** Force-kill a running sandbox container. */
    /**
     * 强杀容器。**只允许杀虾池容器**（带 iml.sandbox 标签的一次性执行容器）。
     *
     * 常驻基础服务（文档引擎 / 向量模型）绝不允许经此杀掉 —— 杀了向量模型，整个知识库检索直接失效；
     * 杀了文档引擎，所有 PDF/Office 入库全废。前端不显示按钮是不够的：接口裸奔，一个 curl 就能干掉。
     * 它们的起停走 `bash scripts/docker-services.sh up|down`，有编排、有校验。
     */
    public Map<String, Object> killContainer(String host, String containerId) {
        String target = resolveHost(host);
        Map<String, Object> result = new LinkedHashMap<>();
        try (DockerClient client = buildClient(target)) {
            InspectContainerResponse info = client.inspectContainerCmd(containerId).exec();
            String name = info.getName() == null ? "" : (info.getName().startsWith("/") ? info.getName().substring(1) : info.getName());
            boolean isSandbox = info.getConfig() != null && info.getConfig().getLabels() != null
                    && info.getConfig().getLabels().containsKey(SANDBOX_LABEL);
            if (BASE_SERVICES.containsKey(name) || !isSandbox) {
                result.put("success", false);
                result.put("message", BASE_SERVICES.containsKey(name)
                        ? "「" + BASE_SERVICES.get(name) + "」是常驻基础服务，不能在这里强杀（杀了会让相关功能整体失效）。"
                                + "起停请用：bash scripts/docker-services.sh up|down"
                        : "该容器不是虾池容器（无 iml.sandbox 标签），拒绝强杀。");
                return result;
            }
            client.killContainerCmd(containerId).exec();
            result.put("success", true);
            result.put("containerId", containerId);
            result.put("message", "容器已强制终止");
        } catch (Throwable t) {
            log.warn("[Docker] killContainer {} failed: {}", containerId, t.getMessage());
            result.put("success", false);
            result.put("message", "强杀失败: " + t.getMessage());
        }
        return result;
    }
}
