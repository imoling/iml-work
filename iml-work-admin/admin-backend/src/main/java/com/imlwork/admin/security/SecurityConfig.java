package com.imlwork.admin.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

import static com.imlwork.admin.security.Permissions.*;

/**
 * 鉴权与授权：无状态 JWT。策略分三层：
 *  ① 公开：登录、Swagger、模型推理端点（服务间共享密钥）、错误页；
 *  ② 共享操作（任一登录用户，含 client.use 员工）：领用岗位、读岗位/技能/业务系统/企业信息、
 *     个人知识库检索/入库/提名/删除、附件解析、文件同步、埋点上报等；
 *  ③ 管理操作：按细粒度权限点守卫（岗位/技能/知识审批/业务系统/FDE/企业信息/网关/沙箱/解析引擎/用户）。
 * 其余一律要求登录。规则按声明顺序匹配，先具体后宽泛。
 */
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    private final JwtAuthFilter jwtAuthFilter;

    public SecurityConfig(JwtAuthFilter jwtAuthFilter) {
        this.jwtAuthFilter = jwtAuthFilter;
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
                .csrf(csrf -> csrf.disable())
                .cors(cors -> {})
                .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        // ── ① 公开 ──
                        .requestMatchers("/api/v1/auth/login", "/api/v1/auth/forgot").permitAll()
                        .requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                        .requestMatchers("/api/v1/model/chat").permitAll()
                        // 探活端点（负载均衡/K8s liveness 用；只回 UP/DOWN，不含指标细节）
                        .requestMatchers("/actuator/health").permitAll()
                        .requestMatchers("/error").permitAll()

                        // ── 登录自服务 ──
                        .requestMatchers("/api/v1/auth/me", "/api/v1/auth/change-password").authenticated()

                        // ── 数据字典：读=全员（客户端分类下拉），写=企业信息管理 ──
                        .requestMatchers(HttpMethod.GET, "/api/v1/dicts/**").authenticated()
                        .requestMatchers("/api/v1/dicts/**").hasAuthority(ENTERPRISE_MANAGE)

                        // ── 用户与权限管理 ──
                        .requestMatchers("/api/v1/users/**", "/api/v1/roles/**").hasAuthority(USER_MANAGE)

                        // ── 模型网关：/chat 由控制器内 corp key 校验（见上 permitAll）；提供商配置需 GATEWAY_MANAGE；
                        //    其余网关端点（/stats 等）需登录，不再对匿名开放 ──
                        .requestMatchers("/api/v1/model/providers/**").hasAuthority(GATEWAY_MANAGE)
                        .requestMatchers("/api/v1/model/**").authenticated()

                        // ── ② 共享操作（任一登录用户）──
                        .requestMatchers(HttpMethod.POST, "/api/v1/experts/claim/**").authenticated()
                        .requestMatchers(HttpMethod.GET, "/api/v1/experts/**").authenticated()
                        .requestMatchers(HttpMethod.GET, "/api/v1/skills/**").authenticated()
                        .requestMatchers(HttpMethod.GET, "/api/v1/integrations/**").authenticated()
                        .requestMatchers(HttpMethod.GET, "/api/v1/enterprise").authenticated()
                        .requestMatchers(HttpMethod.GET, "/api/v1/search-config").authenticated()
                        .requestMatchers("/api/v1/knowledge/query", "/api/v1/knowledge/ingest").authenticated()
                        .requestMatchers(HttpMethod.GET, "/api/v1/knowledge/docs").authenticated()
                        .requestMatchers(HttpMethod.POST, "/api/v1/knowledge/docs/*/promote").authenticated()
                        .requestMatchers(HttpMethod.DELETE, "/api/v1/knowledge/docs/**").authenticated()
                        .requestMatchers("/api/v1/parse/document", "/api/v1/parse/status").authenticated()
                        .requestMatchers("/api/v1/sync/**", "/api/v1/clients/**",
                                "/api/v1/traces/**", "/api/v1/confirmations/**").authenticated()
                        // 客户端执行本体写动作时需读取「绑定的连接器动作」步骤（与技能 GET 同理）；列表与写仍需 INTEGRATION_MANAGE
                        .requestMatchers(HttpMethod.GET, "/api/v1/connector-actions/*").authenticated()
                        // 本体：读定义 + 写对象引用/业务事件对任一登录用户开放（客户端运行时需要）
                        .requestMatchers(HttpMethod.GET, "/api/v1/ontology/**").authenticated()
                        .requestMatchers(HttpMethod.POST, "/api/v1/ontology/events",
                                "/api/v1/ontology/object-refs").authenticated()
                        // 代码执行沙箱：执行 + 执行状态是员工用「代码执行型技能」的必经路径，登录即可；
                        // 配置/容器管理(config、docker/ping、containers)仍需 SANDBOX_MANAGE，见 ③。
                        .requestMatchers("/api/v1/sandbox/exec", "/api/v1/sandbox/exec/status").authenticated()

                        // ── ③ 管理操作（细粒度权限点）──
                        .requestMatchers("/api/v1/ontology/**").hasAuthority(ONTOLOGY_MANAGE)
                        .requestMatchers("/api/v1/experts/**").hasAuthority(EXPERT_MANAGE)
                        .requestMatchers("/api/v1/skills/from-recording").hasAuthority(FDE_SKILL_AUTHOR)
                        .requestMatchers("/api/v1/skills/**").hasAuthority(SKILL_MANAGE)
                        .requestMatchers("/api/v1/knowledge/upload").hasAuthority(KNOWLEDGE_MANAGE)
                        .requestMatchers("/api/v1/knowledge/promotions",
                                "/api/v1/knowledge/docs/*/approve", "/api/v1/knowledge/docs/*/reject").hasAuthority(KNOWLEDGE_APPROVE)
                        .requestMatchers("/api/v1/knowledge/**").hasAuthority(KNOWLEDGE_MANAGE)
                        .requestMatchers("/api/v1/integrations/**", "/api/v1/connections/**",
                                "/api/v1/connector-actions/**").hasAuthority(INTEGRATION_MANAGE)
                        .requestMatchers("/api/v1/fde/**", "/api/v1/tools/recorder/**").hasAuthority(FDE_ACCESS)
                        .requestMatchers("/api/v1/enterprise", "/api/v1/enterprise/**").hasAuthority(ENTERPRISE_MANAGE)
                        .requestMatchers("/api/v1/search-config", "/api/v1/search-config/**").hasAuthority(SEARCH_MANAGE)
                        .requestMatchers("/api/v1/dashboard/**").hasAuthority(DASHBOARD_VIEW)
                        .requestMatchers("/api/v1/monitor/**").hasAuthority(DASHBOARD_VIEW)
                        .requestMatchers("/api/v1/sandbox/**").hasAuthority(SANDBOX_MANAGE)
                        .requestMatchers("/api/v1/parse/**").hasAuthority(DOCLING_MANAGE)

                        // ── 其余：登录即可 ──
                        .anyRequest().authenticated())
                .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }
}
