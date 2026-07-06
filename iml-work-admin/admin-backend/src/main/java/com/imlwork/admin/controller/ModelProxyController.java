package com.imlwork.admin.controller;

import com.imlwork.admin.service.ModelProxyService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 企业模型中转站统一入口。调度/容灾/DLP/兜底逻辑见 {@link ModelProxyService}，
 * 控制器只做网关鉴权塑形与委托。
 */
@RestController
@RequestMapping("/api/v1/model")
public class ModelProxyController {

    private final ModelProxyService modelProxyService;

    public ModelProxyController(ModelProxyService modelProxyService) {
        this.modelProxyService = modelProxyService;
    }

    @PostMapping("/chat")
    public ResponseEntity<?> chatCompletion(
            @RequestBody Map<String, Object> payload,
            @RequestHeader(value = "Authorization", required = false) String authHeader) {

        // 网关鉴权：必须携带服务间共享密钥（corp key），否则拒绝——防止未登录者盗用企业模型额度。
        if (!modelProxyService.authorized(authHeader)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("error", Map.of("message", "未授权：模型网关需要有效的服务密钥", "type", "unauthorized")));
        }

        return modelProxyService.chat(payload);
    }

    @GetMapping("/stats")
    public ResponseEntity<Map<String, Object>> getProxyStats() {
        return ResponseEntity.ok(modelProxyService.stats());
    }
}
