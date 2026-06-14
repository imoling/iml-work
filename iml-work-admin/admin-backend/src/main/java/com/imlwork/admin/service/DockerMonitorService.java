package com.imlwork.admin.service;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.model.Container;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
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
