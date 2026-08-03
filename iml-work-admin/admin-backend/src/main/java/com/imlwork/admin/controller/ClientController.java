package com.imlwork.admin.controller;

import com.imlwork.admin.model.ClientNode;
import com.imlwork.admin.service.ClientNodeService;
import com.imlwork.admin.service.ClientPolicyService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 接收 Electron 客户端节点心跳，并向管理端 SandboxManager 暴露其在线运行状态。
 * 仅做 HTTP 塑形；业务与事务在 {@link ClientNodeService}。
 */
@RestController
@RequestMapping("/api/v1/clients")
public class ClientController {

    private final ClientNodeService service;

    private final ClientPolicyService policyService;

    public ClientController(ClientNodeService service, ClientPolicyService policyService) {
        this.service = service;
        this.policyService = policyService;
    }

    @PostMapping("/heartbeat")
    public ResponseEntity<Map<String, Object>> heartbeat(@RequestBody ClientNode incoming) {
        if (incoming.getClientId() == null || incoming.getClientId().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", "clientId required"));
        }
        // 策略随心跳下发：客户端每次心跳都会拿到最新管控项，管理员改完最迟下一个心跳周期生效，
        // 不需要另开一条轮询。
        return ResponseEntity.ok(Map.of(
                "success", true,
                "clientId", service.upsertHeartbeat(incoming),
                "policy", policyService.forClient()));
    }

    @GetMapping
    public ResponseEntity<List<Map<String, Object>>> list() {
        return ResponseEntity.ok(service.listWithStatus());
    }

    /** 客户端策略：管理员读取当前管控项。 */
    @GetMapping("/policy")
    public ResponseEntity<Map<String, Object>> policy() {
        return ResponseEntity.ok(Map.of("allowCustomModel", policyService.current().isAllowCustomModel()));
    }

    /** 客户端策略：管理员更新。关闭 allowCustomModel 后员工只能走企业模型中转站。 */
    @PutMapping("/policy")
    public ResponseEntity<Map<String, Object>> updatePolicy(@RequestBody Map<String, Object> body) {
        boolean allow = !Boolean.FALSE.equals(body.get("allowCustomModel"));
        return ResponseEntity.ok(Map.of("allowCustomModel", policyService.update(allow).isAllowCustomModel()));
    }

    /** 客户端「检测更新」：转发 nginx /downloads/manifest.json（安装包版本真相源）+ 下载落地页地址。 */
    @GetMapping("/update-manifest")
    public ResponseEntity<Map<String, Object>> updateManifest() {
        return ResponseEntity.ok(service.updateManifest());
    }

    /** 清理离线节点：删除已离线（超出在线窗口未心跳）的陈旧节点，返回删除数。在线节点不动。 */
    @DeleteMapping("/offline")
    public ResponseEntity<Map<String, Object>> pruneOffline() {
        int removed = service.pruneOffline();
        return ResponseEntity.ok(Map.of("success", true, "removed", removed));
    }
}
