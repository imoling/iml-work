package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 文档解析引擎（docling-serve）运行时配置（单例，id 固定为 "default"）。由管理端维护，
 * 无需重启即可调整 —— {@code DoclingService} 每次解析读取当前配置。首次从
 * application.yml 的 {@code docling.*} 默认值播种。
 */
@Entity
@Table(name = "docling_settings")
public class DoclingSettings {

    @Id
    private String id = "default";

    /** docling-serve 服务地址（如 http://localhost:5001）。空 = 未启用（回退基础解析）。 */
    private String endpoint;

    /** 转换端点路径（不同版本可能是 /v1/convert/file 或 /v1alpha/convert/file）。 */
    private String convertPath = "/v1/convert/file";

    /** 是否启用 OCR（扫描件才需要，需服务端装 OCR 引擎；默认关，电子文档不需要）。 */
    private boolean doOcr = false;

    /** 单次解析超时（毫秒）。 */
    private int timeoutMs = 120000;

    // ── 容器化生命周期（经沙箱同款 Docker Remote API 管理）─────────────────
    /** docling-serve 容器镜像。 */
    private String image = "ghcr.io/docling-project/docling-serve";
    /** 宿主机映射端口（容器内固定 5001）。 */
    private int hostPort = 5001;
    /** 固定容器名，用于查找/管理。 */
    private String containerName = "iml-docling-serve";
    /** Docker Remote API 地址；空 = 用沙箱默认（application.yml sandbox.docker.host）。 */
    private String dockerHost = "";

    private LocalDateTime updatedAt = LocalDateTime.now();

    public DoclingSettings() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getEndpoint() { return endpoint; }
    public void setEndpoint(String endpoint) { this.endpoint = endpoint; }

    public String getConvertPath() { return convertPath; }
    public void setConvertPath(String convertPath) { this.convertPath = convertPath; }

    public boolean isDoOcr() { return doOcr; }
    public void setDoOcr(boolean doOcr) { this.doOcr = doOcr; }

    public int getTimeoutMs() { return timeoutMs; }
    public void setTimeoutMs(int timeoutMs) { this.timeoutMs = timeoutMs; }

    public String getImage() { return image; }
    public void setImage(String image) { this.image = image; }

    public int getHostPort() { return hostPort; }
    public void setHostPort(int hostPort) { this.hostPort = hostPort; }

    public String getContainerName() { return containerName; }
    public void setContainerName(String containerName) { this.containerName = containerName; }

    public String getDockerHost() { return dockerHost; }
    public void setDockerHost(String dockerHost) { this.dockerHost = dockerHost; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
