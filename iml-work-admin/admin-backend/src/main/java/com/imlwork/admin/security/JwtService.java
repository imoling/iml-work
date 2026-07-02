package com.imlwork.admin.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import java.util.List;

/** 签发/校验 JWT（HS256）。载荷含 userId、用户名、显示名、角色与权限点。 */
@Service
public class JwtService {

    private final SecretKey key;
    private final long ttlMillis;

    public JwtService(
            @Value("${security.jwt.secret:iml-work-dev-secret-change-me-please-32bytes+}") String secret,
            @Value("${security.jwt.ttl-hours:72}") long ttlHours) {
        // HS256 需要 >= 32 字节密钥；不足则补齐，保证启动不因短密钥失败。
        byte[] bytes = secret.getBytes(StandardCharsets.UTF_8);
        if (bytes.length < 32) {
            byte[] padded = new byte[32];
            System.arraycopy(bytes, 0, padded, 0, bytes.length);
            for (int i = bytes.length; i < 32; i++) padded[i] = '0';
            bytes = padded;
        }
        this.key = Keys.hmacShaKeyFor(bytes);
        this.ttlMillis = ttlHours * 3600_000L;
    }

    public String generate(String userId, String username, String displayName,
                           List<String> roles, List<String> permissions) {
        long now = System.currentTimeMillis();
        return Jwts.builder()
                .subject(userId)
                .claim("username", username)
                .claim("displayName", displayName)
                .claim("roles", roles)
                .claim("perms", permissions)
                .issuedAt(new Date(now))
                .expiration(new Date(now + ttlMillis))
                .signWith(key)
                .compact();
    }

    /** 校验并解析；失败抛异常（由过滤器捕获为 401）。 */
    public Claims parse(String token) {
        return Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
    }
}
