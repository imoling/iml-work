package com.imlwork.admin.security;

import io.jsonwebtoken.Claims;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * JwtService 纯单元测试（无 Spring 上下文 / 无数据库）：
 * 覆盖签发-校验往返，以及 P0 安全修复——生产 profile 下弱/默认密钥必须 fail-fast。
 */
class JwtServiceTest {

    private static final String STRONG_SECRET = "a-strong-jwt-secret-of-at-least-32-bytes!!";

    @Test
    void generateThenParse_roundTrips() {
        JwtService jwt = new JwtService(STRONG_SECRET, 72, "");
        String token = jwt.generate("u-1", "kang", "康Sir",
                List.of("EMPLOYEE"), List.of("client.use"));

        Claims claims = jwt.parse(token);
        assertEquals("u-1", claims.getSubject());
        assertEquals("kang", claims.get("username"));
        assertEquals("康Sir", claims.get("displayName"));
        assertTrue(((List<?>) claims.get("perms")).contains("client.use"));
        assertNotNull(claims.getExpiration());
        assertTrue(claims.getExpiration().after(claims.getIssuedAt()));
    }

    @Test
    void prodWithDefaultSecret_failsFast() {
        assertThrows(IllegalStateException.class,
                () -> new JwtService(JwtService.DEV_DEFAULT_SECRET, 72, "prod"));
    }

    @Test
    void prodWithShortSecret_failsFast() {
        assertThrows(IllegalStateException.class,
                () -> new JwtService("too-short", 72, "prod"));
    }

    @Test
    void devWithDefaultSecret_isAllowed() {
        assertDoesNotThrow(() -> new JwtService(JwtService.DEV_DEFAULT_SECRET, 72, ""));
    }

    @Test
    void parseRejectsTokenSignedByDifferentKey() {
        JwtService a = new JwtService(STRONG_SECRET, 72, "");
        JwtService b = new JwtService("another-totally-different-32byte-secret!!", 72, "");
        String token = a.generate("u-1", "kang", "康Sir", List.of(), List.of());
        assertThrows(Exception.class, () -> b.parse(token));
    }
}
