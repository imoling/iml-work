package com.imlwork.admin.service;

import com.imlwork.admin.model.DoclingSettings;
import com.imlwork.admin.model.SandboxConfig;
import com.imlwork.admin.repository.SandboxConfigRepository;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * docling 解析引擎运维编排：状态组装、配置读写、容器生命周期（经沙箱同款 Docker
 * Remote API）、文档解析降级契约。跨 {@link DoclingService} / {@link DockerMonitorService} /
 * 沙箱配置的编排在此，控制器只做 HTTP 塑形。
 */
@Service
public class DoclingOpsService {

    private final DoclingService docling;
    private final DockerMonitorService docker;
    private final SandboxConfigRepository sandboxConfigRepository;

    public DoclingOpsService(DoclingService docling, DockerMonitorService docker,
                             SandboxConfigRepository sandboxConfigRepository) {
        this.docling = docling;
        this.docker = docker;
        this.sandboxConfigRepository = sandboxConfigRepository;
    }

    /**
     * Docker 连接统一以「沙箱管理」的 dockerEndpoint 为单一配置源（docling 容器托管走同一个
     * daemon，不再各配各的）。DoclingSettings.dockerHost 仅作为遗留覆盖项：显式配置过才生效。
     */
    private String effectiveDockerHost() {
        String legacy = docling.settings().getDockerHost();
        if (legacy != null && !legacy.isBlank()) return legacy;
        return sandboxConfigRepository.findById(1L)
                .map(SandboxConfig::getDockerEndpoint)
                .orElse("");
    }

    /** 状态查询：force=true 为管理端「检测」按钮的强制探活。 */
    public Map<String, Object> status(boolean forceProbe) {
        docling.checkHealth(forceProbe);
        return buildStatus();
    }

    /** 当前运行时配置（管理端配置表单）。 */
    public DoclingSettings settings() {
        return docling.settings();
    }

    /** 更新运行时配置（endpoint / convertPath / doOcr / timeout），随后强制探活。无需重启。 */
    public DoclingSettings updateSettings(DoclingSettings update) {
        DoclingSettings saved = docling.updateSettings(update);
        docling.checkHealth(true);
        return saved;
    }

    /** Rich status for the admin monitor: config + live health + parse metrics. */
    private Map<String, Object> buildStatus() {
        DoclingSettings s = docling.settings();
        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("total", docling.getTotalParses());
        metrics.put("success", docling.getSuccessParses());
        metrics.put("failed", docling.getFailedParses());
        metrics.put("avgLatencyMs", docling.getAvgLatencyMs());

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("configured", docling.isConfigured());
        m.put("online", docling.isOnline());
        m.put("endpoint", s.getEndpoint());
        m.put("convertPath", s.getConvertPath());
        m.put("doOcr", s.isDoOcr());
        m.put("timeoutMs", s.getTimeoutMs());
        m.put("probeLatencyMs", docling.getLastProbeLatencyMs());
        m.put("probeError", docling.getLastProbeError());
        m.put("lastCheckAt", docling.getLastProbeAt());
        m.put("metrics", metrics);
        // 容器化管理信息（镜像/端口/容器状态/生命周期阶段）
        m.put("image", s.getImage());
        m.put("hostPort", s.getHostPort());
        m.put("containerName", s.getContainerName());
        m.put("dockerEndpoint", effectiveDockerHost());   // 生效的 Docker 地址（与沙箱共用），供前端只读展示
        m.put("container", docker.doclingContainerStatus(effectiveDockerHost(), s.getContainerName()));
        return m;
    }

    /** 启动 docling 容器（按需拉镜像/创建）。异步执行，轮询 status 观察阶段。 */
    public Map<String, Object> startContainer() {
        DoclingSettings s = docling.settings();
        Map<String, Object> r = docker.startDocling(effectiveDockerHost(), s.getImage(), s.getContainerName(), s.getHostPort());
        // 首次启动且未配置解析地址时，自动指向本机映射端口
        if (s.getEndpoint() == null || s.getEndpoint().isBlank()) {
            s.setEndpoint("http://localhost:" + s.getHostPort());
            docling.updateSettings(s);
        }
        return r;
    }

    /** 停止 docling 容器（保留容器，便于快速再启动）。 */
    public Map<String, Object> stopContainer() {
        DoclingSettings s = docling.settings();
        return docker.stopDocling(effectiveDockerHost(), s.getContainerName(), 15);
    }

    /** 重启：先停后启（异步启动）。 */
    public Map<String, Object> restartContainer() {
        DoclingSettings s = docling.settings();
        docker.stopDocling(effectiveDockerHost(), s.getContainerName(), 15);
        return docker.startDocling(effectiveDockerHost(), s.getImage(), s.getContainerName(), s.getHostPort());
    }

    /**
     * 解析一份文档为 Markdown。契约：永远返回可 200 直出的 Map；{@code ok:false} 让
     * 客户端无需处理 HTTP 错误即可回退本地基础解析。
     */
    public Map<String, Object> parseDocument(MultipartFile file) {
        String name = file.getOriginalFilename() == null ? "upload" : file.getOriginalFilename();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("filename", name);
        try {
            if (!docling.isConfigured()) {
                m.put("ok", false);
                m.put("reason", "docling-not-configured");
                return m;
            }
            String md = docling.toMarkdown(file.getBytes(), name);
            m.put("ok", true);
            m.put("markdown", md);
            return m;
        } catch (Exception e) {
            m.put("ok", false);
            m.put("reason", "parse-failed");
            m.put("error", String.valueOf(e.getMessage()));
            return m;
        }
    }
}
