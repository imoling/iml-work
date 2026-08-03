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

    /**
     * 网关可用模型清单（corp key 鉴权）：客户端 proxy 模式的模型选择器数据源。
     * 返回别名（corp-default / corp-reasoning）+ 各启用通道的 routeKey/model——
     * 客户端选的是**网关认识的名字**，而不是让用户去猜上游模型名。
     */
    @GetMapping("/models")
    public ResponseEntity<?> listGatewayModels(
            @RequestHeader(value = "Authorization", required = false) String authHeader) {
        if (!modelProxyService.authorized(authHeader)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("error", Map.of("message", "未授权：模型网关需要有效的服务密钥", "type", "unauthorized")));
        }
        return ResponseEntity.ok(modelProxyService.gatewayModels());
    }

    /** 文生图：同步返回图片 URL。走通道 modelType=image；没有该类型时 fail-open 到全池。 */
    @PostMapping("/images/generations")
    public ResponseEntity<?> imageGenerations(
            @RequestHeader(value = "Authorization", required = false) String authHeader,
            @RequestBody Map<String, Object> payload) {
        if (!modelProxyService.authorized(authHeader)) return unauthorized();
        return modelProxyService.mediaGenerate(payload, "/images/generations", "image", 180);
    }

    /** 文生视频：**异步任务**——本接口提交后返回 task_id，用 GET /videos/{id} 轮询。 */
    @PostMapping("/videos")
    public ResponseEntity<?> videoCreate(
            @RequestHeader(value = "Authorization", required = false) String authHeader,
            @RequestBody Map<String, Object> payload) {
        if (!modelProxyService.authorized(authHeader)) return unauthorized();
        return modelProxyService.mediaGenerate(payload, "/videos", "video", 120);
    }

    /** 视频任务状态轮询（status/progress/完成后的下载地址）。 */
    @GetMapping("/videos/{taskId}")
    public ResponseEntity<?> videoStatus(
            @RequestHeader(value = "Authorization", required = false) String authHeader,
            @PathVariable String taskId) {
        if (!modelProxyService.authorized(authHeader)) return unauthorized();
        return modelProxyService.mediaStatus("/videos/" + taskId, "video", 60);
    }

    private ResponseEntity<?> unauthorized() {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("error", Map.of("message", "未授权：模型网关需要有效的服务密钥", "type", "unauthorized")));
    }

    /**
     * 按**模型名**推断档位（corp key 鉴权，不发探针、不需要厂商密钥）。
     *
     * 放在这条路径而不是 /model/providers 下：那条是管理端专用（管理员鉴权），
     * 而这个接口的消费者是**客户端配置页**——员工拉到上游模型列表后给每项标个档位。
     * 客户端直连厂商时密钥只在本机，不该为了标类型把它发上来，所以只传模型名。
     * 规则来源仍是后端 ModelTypeGuess，避免客户端另抄一份判定逻辑。
     */
    @PostMapping("/guess-types")
    public ResponseEntity<?> guessTypes(
            @RequestHeader(value = "Authorization", required = false) String authHeader,
            @RequestBody Map<String, Object> body) {
        if (!modelProxyService.authorized(authHeader)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("error", Map.of("message", "未授权：模型网关需要有效的服务密钥", "type", "unauthorized")));
        }
        Object models = body.get("models");
        @SuppressWarnings("unchecked")
        java.util.List<String> list = models instanceof java.util.List<?> l ? (java.util.List<String>) l : java.util.List.of();
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        for (String m : list.stream().limit(100).toList()) {
            String t = com.imlwork.admin.service.ModelTypeGuess.of(m);
            out.put(m, Map.of(
                    "type", t,
                    "chatCapable", com.imlwork.admin.service.ModelTypeGuess.isChatCapable(m),
                    "tierName", com.imlwork.admin.service.ModelTiers.byModelType(t).name()));
        }
        return ResponseEntity.ok(Map.of("results", out));
    }
}
