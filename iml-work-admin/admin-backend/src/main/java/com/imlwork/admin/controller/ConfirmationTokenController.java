package com.imlwork.admin.controller;

import com.imlwork.admin.model.ConfirmationToken;
import com.imlwork.admin.repository.ConfirmationTokenRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 策略与确认服务（文档 §12.6）：签发 / 校验 / 消费一次性签名确认令牌。
 * 只接收表单摘要（formDataHash），不接收明文业务字段。
 */
@RestController
@RequestMapping("/api/v1/confirmations")
public class ConfirmationTokenController {

    private final ConfirmationTokenRepository repo;
    // 第一版：固定服务端密钥（真实环境应来自密钥库 / 非对称签名）
    private static final String SECRET = "iml-confirm-hmac-secret-v1";
    private static final long DEFAULT_TTL_SECONDS = 300;

    public ConfirmationTokenController(ConfirmationTokenRepository repo) {
        this.repo = repo;
    }

    private static String nz(String s) { return s == null ? "" : s; }

    private static String canonical(ConfirmationToken t) {
        return String.join("|", nz(t.getId()), nz(t.getTenantId()), nz(t.getUserId()), nz(t.getConnectionId()),
                nz(t.getSkillId()), nz(t.getActionId()), nz(t.getCapability()), nz(t.getTargetObjectHash()),
                nz(t.getFormDataHash()), String.valueOf(t.getIssuedAt()), String.valueOf(t.getExpiresAt()), nz(t.getNonce()));
    }

    private static String hmac(String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] h = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : h) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    private static String str(Map<String, Object> b, String k) {
        Object v = b.get(k);
        return v == null ? null : String.valueOf(v);
    }

    /** 签发令牌：用户确认写操作后调用。 */
    @PostMapping
    public ConfirmationToken issue(@RequestBody Map<String, Object> body) {
        ConfirmationToken t = new ConfirmationToken();
        t.setId("tok-" + UUID.randomUUID().toString().substring(0, 12));
        t.setTenantId(str(body, "tenantId") == null ? "default" : str(body, "tenantId"));
        t.setUserId(str(body, "userId"));
        t.setConnectionId(str(body, "connectionId"));
        t.setSkillId(str(body, "skillId"));
        t.setActionId(str(body, "actionId"));
        t.setCapability(str(body, "capability"));
        t.setTargetObjectHash(str(body, "targetObjectHash"));
        t.setFormDataHash(str(body, "formDataHash"));
        t.setNonce(UUID.randomUUID().toString());
        long ttl = DEFAULT_TTL_SECONDS;
        try { if (body.get("ttlSeconds") != null) ttl = Long.parseLong(String.valueOf(body.get("ttlSeconds"))); } catch (Exception ignored) {}
        LocalDateTime now = LocalDateTime.now();
        t.setIssuedAt(now);
        t.setExpiresAt(now.plusSeconds(ttl));
        t.setStatus("issued");
        t.setSignature(hmac(canonical(t)));
        return repo.save(t);
    }

    /** 校验并消费令牌（一次性）：连接器执行前调用。校验签名/有效期/状态/用户/连接/动作/表单摘要。 */
    @PostMapping("/{id}/consume")
    public ResponseEntity<Map<String, Object>> consume(@PathVariable String id, @RequestBody Map<String, Object> body) {
        ConfirmationToken t = repo.findById(id).orElse(null);
        if (t == null) return ResponseEntity.ok(Map.of("ok", false, "reason", "令牌不存在"));
        if (!"issued".equals(t.getStatus())) return ResponseEntity.ok(Map.of("ok", false, "reason", "令牌已使用或失效（" + t.getStatus() + "）"));
        if (t.getExpiresAt() != null && LocalDateTime.now().isAfter(t.getExpiresAt())) {
            t.setStatus("expired"); repo.save(t);
            return ResponseEntity.ok(Map.of("ok", false, "reason", "令牌已过期"));
        }
        if (!hmac(canonical(t)).equals(t.getSignature()))
            return ResponseEntity.ok(Map.of("ok", false, "reason", "签名校验失败"));
        // 与执行端声明逐项比对
        if (mismatch(str(body, "userId"), t.getUserId())) return ResponseEntity.ok(Map.of("ok", false, "reason", "用户不匹配"));
        if (mismatch(str(body, "connectionId"), t.getConnectionId())) return ResponseEntity.ok(Map.of("ok", false, "reason", "连接不匹配"));
        if (mismatch(str(body, "actionId"), t.getActionId())) return ResponseEntity.ok(Map.of("ok", false, "reason", "动作不匹配"));
        if (mismatch(str(body, "formDataHash"), t.getFormDataHash())) return ResponseEntity.ok(Map.of("ok", false, "reason", "表单已变更，请重新确认"));
        // 通过 → 即焚
        t.setStatus("consumed");
        t.setConsumedAt(LocalDateTime.now());
        repo.save(t);
        return ResponseEntity.ok(Map.of("ok", true, "tokenId", t.getId()));
    }

    private static boolean mismatch(String incoming, String stored) {
        // 调用方未提供该项则不校验；提供了就必须相等
        return incoming != null && !incoming.equals(nz(stored));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ConfirmationToken> get(@PathVariable String id) {
        return repo.findById(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping
    public List<ConfirmationToken> list(@RequestParam(required = false) String connectionId) {
        if (connectionId != null && !connectionId.isBlank()) return repo.findByConnectionIdOrderByIssuedAtDesc(connectionId);
        return repo.findAll();
    }

    @PostMapping("/{id}/revoke")
    public ResponseEntity<ConfirmationToken> revoke(@PathVariable String id) {
        return repo.findById(id).map(t -> { t.setStatus("revoked"); return ResponseEntity.ok(repo.save(t)); })
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
