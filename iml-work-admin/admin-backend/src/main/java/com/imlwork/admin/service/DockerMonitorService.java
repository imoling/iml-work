package com.imlwork.admin.service;

import com.github.dockerjava.api.DockerClient;
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

    private static final Logger log = LoggerFactory.getLogger(DockerMonitorService.class);

    @Value("${sandbox.docker.host:unix:///var/run/docker.sock}")
    private String defaultHost;

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

    private String resolveHost(String host) {
        return (host == null || host.isBlank()) ? defaultHost : host;
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
            result.put("message", "无法连接 Docker 守护进程: " + t.getMessage());
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
            List<Map<String, Object>> rows = new ArrayList<>();
            for (Container c : containers) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", c.getId());
                row.put("shortId", c.getId() != null && c.getId().length() > 12 ? c.getId().substring(0, 12) : c.getId());
                row.put("names", c.getNames());
                row.put("image", c.getImage());
                row.put("state", c.getState());
                row.put("status", c.getStatus());
                rows.add(row);
            }
            result.put("reachable", true);
            result.put("containers", rows);
        } catch (Throwable t) {
            log.warn("[Docker] listContainers failed for {}: {}", target, t.getMessage());
            result.put("reachable", false);
            result.put("containers", new ArrayList<>());
            result.put("message", "无法连接 Docker 守护进程: " + t.getMessage());
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
            result.put("message", "无法连接 Docker 守护进程: " + t.getMessage());
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
    public Map<String, Object> killContainer(String host, String containerId) {
        String target = resolveHost(host);
        Map<String, Object> result = new LinkedHashMap<>();
        try (DockerClient client = buildClient(target)) {
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
