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

    public JwtAuthFilter(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String auth = request.getHeader("Authorization");
        if (auth != null && auth.startsWith("Bearer ")) {
            String token = auth.substring(7).trim();
            try {
                Claims c = jwtService.parse(token);
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
