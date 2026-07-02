package com.imlwork.admin.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import java.util.List;

/** 签发/校验 JWT（HS256）。载荷含 userId、用户名、显示名、角色与权限点。 */
@Service
public class JwtService {

    private static final Logger log = LoggerFactory.getLogger(JwtService.class);
    /** 开发兜底密钥；生产 profile 下若沿用/为空/过短则拒绝启动。 */
    static final String DEV_DEFAULT_SECRET = "iml-work-dev-secret-change-me-please-32bytes+";

    private final SecretKey key;
    private final long ttlMillis;

    public JwtService(
            @Value("${security.jwt.secret:" + DEV_DEFAULT_SECRET + "}") String secret,
            @Value("${security.jwt.ttl-hours:72}") long ttlHours,
            @Value("${spring.profiles.active:}") String activeProfiles) {
        boolean prod = activeProfiles != null && activeProfiles.contains("prod");
        boolean weak = secret == null || secret.isBlank()
                || DEV_DEFAULT_SECRET.equals(secret)
                || secret.getBytes(StandardCharsets.UTF_8).length < 32;
        if (weak) {
            if (prod) {
                // 生产环境绝不允许弱/默认/过短密钥签发 token → 直接 fail-fast。
                throw new IllegalStateException(
                        "生产环境必须显式配置强 JWT 密钥：security.jwt.secret（>= 32 字节，且不得使用开发默认值）。");
            }
            log.warn("⚠️ JWT 使用了开发默认/过短密钥，仅限本地开发。上生产前务必设置 security.jwt.secret（>= 32 字节）。");
        }
        // HS256 需要 >= 32 字节；开发场景下补齐以保证可启动（生产已在上面拦截）。
        byte[] bytes = secret == null ? new byte[0] : secret.getBytes(StandardCharsets.UTF_8);
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
