package com.imlwork.admin.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.servers.Server;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

/**
 * OpenAPI / Swagger UI metadata. Swagger UI is served at /swagger-ui.html and
 * the raw spec at /v3/api-docs (see application.yml). Auto-generates docs for
 * every @RestController on the classpath.
 */
@Configuration
public class OpenApiConfig {

    @Value("${server.port:8080}")
    private String port;

    @Bean
    public OpenAPI imlWorkOpenAPI() {
        return new OpenAPI()
                .info(new Info()
                        .title("iML Work Admin API")
                        .description("iML Work 运营管理后端 REST API —— 岗位专家 / SkillsHub / 知识库(pgvector RAG) / "
                                + "沙箱与 Docker 监控 / 系统集成 / 监控仪表盘 / 统一模型网关 / 客户端心跳")
                        .version("1.0.0")
                        .contact(new Contact().name("iML Studio")))
                .servers(List.of(new Server().url("http://localhost:" + port).description("本地开发服务")));
    }
}
