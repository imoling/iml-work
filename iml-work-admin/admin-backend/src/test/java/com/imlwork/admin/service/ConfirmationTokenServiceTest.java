package com.imlwork.admin.service;

import com.imlwork.admin.model.ConfirmationToken;
import com.imlwork.admin.repository.ConfirmationTokenRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * 一次性签名确认令牌：签发→消费闭环、防重放（二次消费拒绝）、表单变更拒绝、
 * 过期拒绝、签名篡改拒绝、prod 弱密钥拒启动。仓库用 HashMap 假实现（Mockito）。
 */
class ConfirmationTokenServiceTest {

    private final Map<String, ConfirmationToken> store = new HashMap<>();
    private ConfirmationTokenService service;

    @BeforeEach
    void setUp() {
        store.clear();
        ConfirmationTokenRepository repo = Mockito.mock(ConfirmationTokenRepository.class);
        when(repo.save(any(ConfirmationToken.class))).thenAnswer(inv -> {
            ConfirmationToken t = inv.getArgument(0);
            store.put(t.getId(), t);
            return t;
        });
        when(repo.findById(anyString())).thenAnswer(inv -> Optional.ofNullable(store.get(inv.<String>getArgument(0))));
        service = new ConfirmationTokenService(repo, "unit-test-secret", "");
    }

    private static Map<String, Object> issueBody() {
        Map<String, Object> b = new HashMap<>();
        b.put("userId", "u1");
        b.put("connectionId", "conn1");
        b.put("actionId", "approve");
        b.put("formDataHash", "hash-1");
        return b;
    }

    @Test
    void 签发后按原样消费_成功且只此一次() {
        ConfirmationToken t = service.issue(issueBody());
        assertEquals("issued", t.getStatus());
        assertNotNull(t.getSignature());

        Map<String, Object> r1 = service.consume(t.getId(), issueBody());
        assertEquals(true, r1.get("ok"));
        assertEquals("consumed", store.get(t.getId()).getStatus());

        // 防重放：同一令牌二次消费必须拒绝
        Map<String, Object> r2 = service.consume(t.getId(), issueBody());
        assertEquals(false, r2.get("ok"));
        assertTrue(String.valueOf(r2.get("reason")).contains("已使用"));
    }

    @Test
    void 表单摘要变更_拒绝消费() {
        ConfirmationToken t = service.issue(issueBody());
        Map<String, Object> body = issueBody();
        body.put("formDataHash", "hash-2");   // 用户确认后表单被改动
        Map<String, Object> r = service.consume(t.getId(), body);
        assertEquals(false, r.get("ok"));
        assertTrue(String.valueOf(r.get("reason")).contains("表单已变更"));
        assertEquals("issued", store.get(t.getId()).getStatus());   // 未被消费
    }

    @Test
    void 用户或动作不匹配_拒绝消费() {
        ConfirmationToken t = service.issue(issueBody());
        Map<String, Object> body = issueBody();
        body.put("userId", "u2");
        assertEquals(false, service.consume(t.getId(), body).get("ok"));

        Map<String, Object> body2 = issueBody();
        body2.put("actionId", "delete");
        assertEquals(false, service.consume(t.getId(), body2).get("ok"));
    }

    @Test
    void 过期令牌_拒绝并标记expired() {
        Map<String, Object> b = issueBody();
        b.put("ttlSeconds", "-1");   // 签发即过期
        ConfirmationToken t = service.issue(b);
        Map<String, Object> r = service.consume(t.getId(), issueBody());
        assertEquals(false, r.get("ok"));
        assertTrue(String.valueOf(r.get("reason")).contains("过期"));
        assertEquals("expired", store.get(t.getId()).getStatus());
    }

    @Test
    void 存储被篡改_签名校验拒绝() {
        ConfirmationToken t = service.issue(issueBody());
        store.get(t.getId()).setTargetObjectHash("tampered");   // 模拟落库后被改
        Map<String, Object> r = service.consume(t.getId(), issueBody());
        assertEquals(false, r.get("ok"));
        assertTrue(String.valueOf(r.get("reason")).contains("签名"));
    }

    @Test
    void 未知令牌_拒绝() {
        Map<String, Object> r = service.consume("tok-not-exist", issueBody());
        assertEquals(false, r.get("ok"));
    }

    @Test
    void prod环境使用开发默认密钥_拒绝启动() {
        ConfirmationTokenRepository repo = Mockito.mock(ConfirmationTokenRepository.class);
        assertThrows(IllegalStateException.class,
                () -> new ConfirmationTokenService(repo, ConfirmationTokenService.DEV_DEFAULT_SECRET, "prod"));
    }
}
