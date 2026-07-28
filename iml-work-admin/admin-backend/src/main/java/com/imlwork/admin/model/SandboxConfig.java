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
    // 硬 kill 超时。pip 安装计入本窗口，取数类技能（多包依赖 + 多端点联网拉数）120s 会被中途掐死；
    // 客户端 HTTP 超时（skill-exec.ts execViaBackendSandbox）须始终大于此值 + 容器创建/回传开销。
    private int timeoutSeconds = 180;
    private boolean networkIsolation = true;

    /**
     * 出网依赖包白名单（逗号/空格分隔的 pip 包名）。网络隔离开启时，申报 packages 的执行仅在
     * **装包阶段**联网（装完即断网跑用户代码，见 SandboxExecService 两阶段切换）；白名单非空则只放行
     * 名单内的包——名单外直接拒绝执行。**空 = 拒绝任何申报包**（体检 P2-1·拍板 C：默认收紧，
     * 曾是"空=不限制"，默认部署等于全网放行）。管理员须在「沙箱监控」显式配置白名单。
     */
    @Column(columnDefinition = "text")
    private String networkPackages;

    /**
     * pip 内网镜像地址（如 https://mirrors.corp.example/pypi/simple）。配置后装包阶段
     * `pip install -i <url> --trusted-host <host>`——依赖获取收敛到企业镜像，不再直连公网 PyPI。
     * 空 = 用镜像内置默认源（装包阶段仍联网，但运行阶段一律断网）。
     */
    @Column(length = 300)
    private String pipIndexUrl;

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

    public String getPipIndexUrl() { return pipIndexUrl; }
    public void setPipIndexUrl(String pipIndexUrl) { this.pipIndexUrl = pipIndexUrl; }

    public String getNetworkPackages() { return networkPackages; }
    public void setNetworkPackages(String networkPackages) { this.networkPackages = networkPackages; }
}
