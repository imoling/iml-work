package com.imlwork.admin.service;

import com.imlwork.admin.model.ConfirmationToken;
import com.imlwork.admin.repository.ConfirmationTokenRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 一次性签名确认令牌领域服务（文档 §12.6）：签发 / 校验 / 消费。
 * 只接收表单摘要（formDataHash），不接收明文业务字段。HMAC 密钥来自配置；
 * 生产 profile 下沿用开发默认即拒绝启动。
 */
@Service
public class ConfirmationTokenService {

    private static final Logger log = LoggerFactory.getLogger(ConfirmationTokenService.class);
    static final String DEV_DEFAULT_SECRET = "iml-confirm-hmac-secret-v1";
    private static final long DEFAULT_TTL_SECONDS = 300;

    private final ConfirmationTokenRepository repo;
    private final String secret;

    public ConfirmationTokenService(
            ConfirmationTokenRepository repo,
            @Value("${security.confirm.hmac-secret:" + DEV_DEFAULT_SECRET + "}") String secret,
            @Value("${spring.profiles.active:}") String activeProfiles) {
        this.repo = repo;
        boolean prod = activeProfiles != null && activeProfiles.contains("prod");
        boolean weak = secret == null || secret.isBlank() || DEV_DEFAULT_SECRET.equals(secret);
        if (weak && prod) {
            throw new IllegalStateException(
                    "生产环境必须显式配置确认令牌密钥：security.confirm.hmac-secret（不得使用开发默认值）。");
        }
        if (weak) log.warn("⚠️ 确认令牌使用了开发默认 HMAC 密钥，仅限本地开发。上生产前请设置 security.confirm.hmac-secret。");
        this.secret = (secret == null || secret.isBlank()) ? DEV_DEFAULT_SECRET : secret;
    }

    /** 签发令牌：用户确认写操作后调用。 */
    @Transactional
    public ConfirmationToken issue(Map<String, Object> body) {
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

    /** 校验并消费令牌（一次性）：连接器执行前调用。 */
    @Transactional
    public Map<String, Object> consume(String id, Map<String, Object> body) {
        ConfirmationToken t = repo.findById(id).orElse(null);
        if (t == null) return fail("令牌不存在");
        if (!"issued".equals(t.getStatus())) return fail("令牌已使用或失效（" + t.getStatus() + "）");
        if (t.getExpiresAt() != null && LocalDateTime.now().isAfter(t.getExpiresAt())) {
            t.setStatus("expired"); repo.save(t);
            return fail("令牌已过期");
        }
        if (!hmac(canonical(t)).equals(t.getSignature())) return fail("签名校验失败");
        if (mismatch(str(body, "userId"), t.getUserId())) return fail("用户不匹配");
        if (mismatch(str(body, "connectionId"), t.getConnectionId())) return fail("连接不匹配");
        if (mismatch(str(body, "actionId"), t.getActionId())) return fail("动作不匹配");
        if (mismatch(str(body, "formDataHash"), t.getFormDataHash())) return fail("表单已变更，请重新确认");
        t.setStatus("consumed");
        t.setConsumedAt(LocalDateTime.now());
        repo.save(t);
        Map<String, Object> ok = new LinkedHashMap<>();
        ok.put("ok", true); ok.put("tokenId", t.getId());
        return ok;
    }

    @Transactional(readOnly = true)
    public ConfirmationToken get(String id) {
        return repo.findById(id).orElse(null);
    }

    private static Map<String, Object> fail(String reason) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", false); m.put("reason", reason);
        return m;
    }

    private static String nz(String s) { return s == null ? "" : s; }

    private static String canonical(ConfirmationToken t) {
        return String.join("|", nz(t.getId()), nz(t.getTenantId()), nz(t.getUserId()), nz(t.getConnectionId()),
                nz(t.getSkillId()), nz(t.getActionId()), nz(t.getCapability()), nz(t.getTargetObjectHash()),
                nz(t.getFormDataHash()), String.valueOf(t.getIssuedAt()), String.valueOf(t.getExpiresAt()), nz(t.getNonce()));
    }

    private String hmac(String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
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

    private static boolean mismatch(String incoming, String stored) {
        return incoming != null && !incoming.equals(nz(stored));
    }
}
