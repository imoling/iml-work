package com.imlwork.admin.controller;

import com.imlwork.admin.model.SandboxConfig;
import com.imlwork.admin.service.DockerMonitorService;
import com.imlwork.admin.service.SandboxConfigService;
import com.imlwork.admin.service.SandboxExecService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 公司级代码执行沙箱：配置（单例 row id=1）+ Docker 联通探测 + 在跑容器监控/强杀 +
 * 一次性容器执行（/exec，员工登录即可；配置管理需 SANDBOX_MANAGE，见 SecurityConfig）。
 *
 * <p>注意 /exec 必须保持同步——曾改为 CompletableFuture 异步，Spring Security 异步
 * re-dispatch 丢 SecurityContext 导致一律 403。并发限流由 SandboxExecService 内部信号量完成。
 */
@RestController
@RequestMapping("/api/v1/sandbox")
public class SandboxController {

    private final SandboxConfigService configService;
    private final DockerMonitorService dockerService;
    private final SandboxExecService execService;

    public SandboxController(SandboxConfigService configService, DockerMonitorService dockerService,
                             SandboxExecService execService) {
        this.configService = configService;
        this.dockerService = dockerService;
        this.execService = execService;
    }

    /** 代码执行沙箱状态：Docker 可达性 + 基础镜像就绪。 */
    @GetMapping("/exec/status")
    public ResponseEntity<Map<String, Object>> execStatus() {
        return ResponseEntity.ok(execService.status());
    }

    /**
     * 在一次性 Docker 容器内执行代码执行型技能脚本，产物回传。同步执行（并发闸在 Service 内）。
     * files：可选，agentic 技能的 bundle（相对路径 → base64），tar 上传铺进容器 /work。
     */
    @PostMapping("/exec")
    public ResponseEntity<Map<String, Object>> exec(@RequestBody Map<String, Object> body) {
        String code = String.valueOf(body.getOrDefault("code", ""));
        if (code.isBlank()) throw new IllegalArgumentException("code 不能为空");
        Object pk = body.get("packages");
        @SuppressWarnings("unchecked")
        List<String> pkgs = pk instanceof List<?> l ? (List<String>) l : List.of();
        Map<String, String> files = new java.util.LinkedHashMap<>();
        if (body.get("files") instanceof Map<?, ?> fm) {
            for (Map.Entry<?, ?> e : fm.entrySet()) files.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
        }
        return ResponseEntity.ok(execService.exec(code, pkgs, files));
    }

    @GetMapping("/config")
    public ResponseEntity<SandboxConfig> getConfig() {
        return ResponseEntity.ok(configService.getOrCreate());
    }

    @PutMapping("/config")
    public ResponseEntity<SandboxConfig> updateConfig(@RequestBody SandboxConfig update) {
        return ResponseEntity.ok(configService.update(update));
    }

    /** Probe Docker Remote API connectivity for the given (or configured) endpoint. */
    @PostMapping("/docker/ping")
    public ResponseEntity<Map<String, Object>> ping(@RequestBody(required = false) Map<String, String> body) {
        String host = body != null ? body.get("endpoint") : null;
        return ResponseEntity.ok(dockerService.ping(host));
    }

    @GetMapping("/containers")
    public ResponseEntity<Map<String, Object>> containers(@RequestParam(value = "endpoint", required = false) String endpoint) {
        return ResponseEntity.ok(dockerService.listContainers(endpoint));
    }

    @DeleteMapping("/containers/{id}")
    public ResponseEntity<Map<String, Object>> kill(
            @PathVariable String id,
            @RequestParam(value = "endpoint", required = false) String endpoint) {
        return ResponseEntity.ok(dockerService.killContainer(endpoint, id));
    }
}
