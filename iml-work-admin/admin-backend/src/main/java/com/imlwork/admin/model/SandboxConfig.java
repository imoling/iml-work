package com.imlwork.admin.model;

import jakarta.persistence.*;

/**
 * 公司级代码执行沙箱的单例配置（固定 row id = 1）。整个企业共用一套集中沙箱平面：
 * 不可信技能代码统一在此 Docker 主机（本机 colima / 远程自建）的一次性容器里执行，
 * 员工机器不参与执行。对应管理端「沙箱监控」表单：运行模式、Docker 端点、资源配额。
 */
@Entity
@Table(name = "sandbox_config")
public class SandboxConfig {

    @Id
    private Long id = 1L;

    /** 运行模式：docker=启用公司级 Docker 沙箱（默认）；disabled=停用沙箱（代码执行型技能一律拒绝）。 */
    private String mode = "docker";

    private String dockerEndpoint = "unix:///var/run/docker.sock";

    /** 基础镜像：一次性容器由它创建。可指向预装常用包(python-docx/openpyxl…)的自定义镜像以免每次 pip 联网。 */
    private String baseImage = "python:3.12-slim";

    private double cpuQuota = 1.0;        // CPU cores
    private int memoryQuotaMb = 512;      // MB
    private int timeoutSeconds = 120;     // hard kill timeout
    private boolean networkIsolation = true;

    public SandboxConfig() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getMode() { return mode; }
    public void setMode(String mode) { this.mode = mode; }

    public String getDockerEndpoint() { return dockerEndpoint; }
    public void setDockerEndpoint(String dockerEndpoint) { this.dockerEndpoint = dockerEndpoint; }

    public String getBaseImage() { return baseImage; }
    public void setBaseImage(String baseImage) { this.baseImage = baseImage; }

    public double getCpuQuota() { return cpuQuota; }
    public void setCpuQuota(double cpuQuota) { this.cpuQuota = cpuQuota; }

    public int getMemoryQuotaMb() { return memoryQuotaMb; }
    public void setMemoryQuotaMb(int memoryQuotaMb) { this.memoryQuotaMb = memoryQuotaMb; }

    public int getTimeoutSeconds() { return timeoutSeconds; }
    public void setTimeoutSeconds(int timeoutSeconds) { this.timeoutSeconds = timeoutSeconds; }

    public boolean isNetworkIsolation() { return networkIsolation; }
    public void setNetworkIsolation(boolean networkIsolation) { this.networkIsolation = networkIsolation; }
}
