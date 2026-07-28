package com.imlwork.admin.security;

import io.jsonwebtoken.Claims;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/** 从 Authorization: Bearer 解析 JWT，构造 Authentication（authorities = 权限点）。 */
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    private final JwtService jwtService;
    private final TokenEpochCache tokenEpochs;

    public JwtAuthFilter(JwtService jwtService, TokenEpochCache tokenEpochs) {
        this.jwtService = jwtService;
        this.tokenEpochs = tokenEpochs;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String auth = request.getHeader("Authorization");
        if (auth != null && auth.startsWith("Bearer ")) {
            String token = auth.substring(7).trim();
            try {
                Claims c = jwtService.parse(token);
                // 撤销校验（体检 P2-5）：签发时的纪元与用户当前纪元不符 = 该 token 已被撤销
                // （改密 / 管理员强制下线）。老 token 无 ep claim 视为 0，与初始纪元一致，平滑兼容。
                long tokenEp = c.get("ep") instanceof Number n ? n.longValue() : 0L;
                if (tokenEp != tokenEpochs.current(c.getSubject())) {
                    SecurityContextHolder.clearContext();
                    chain.doFilter(request, response);
                    return;
                }
                List<GrantedAuthority> authorities = new ArrayList<>();
                Object perms = c.get("perms");
                boolean superAdmin = false;
                if (perms instanceof List<?> list) {
                    for (Object p : list) {
                        String s = String.valueOf(p);
                        if (Permissions.ALL.equals(s)) superAdmin = true;
                        authorities.add(new SimpleGrantedAuthority(s));
                    }
                }
                // 超级管理员（*）→ 授予全部权限点，使 hasAuthority 检查全部通过
                if (superAdmin) {
                    for (String p : Permissions.ALL_POINTS) authorities.add(new SimpleGrantedAuthority(p));
                }
                var principal = new AuthPrincipal(c.getSubject(), String.valueOf(c.get("username")),
                        String.valueOf(c.get("displayName")), superAdmin);
                var authentication = new UsernamePasswordAuthenticationToken(principal, null, authorities);
                authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            } catch (Exception e) {
                // 无效/过期 token → 保持未认证，交由后续规则决定 401/403
                SecurityContextHolder.clearContext();
            }
        }
        chain.doFilter(request, response);
    }

    /** 登录主体：userId 作为 name，便于控制器取 owner/用户身份。 */
    public record AuthPrincipal(String userId, String username, String displayName, boolean superAdmin) {
        @Override public String toString() { return userId; }
    }
}
