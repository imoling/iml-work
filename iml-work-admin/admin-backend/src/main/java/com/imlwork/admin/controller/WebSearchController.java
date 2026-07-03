package com.imlwork.admin.controller;

import com.imlwork.admin.dto.SearchDtos.SearchRequest;
import com.imlwork.admin.dto.SearchDtos.WebSearchResponse;
import com.imlwork.admin.service.WebSearchService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * 联网检索代理端点：客户端发查询词，后端用保管的密钥调 Tavily/Bing 后回结果，
 * 密钥绝不下发客户端。鉴权走 SecurityConfig 兜底的「登录即可」。
 */
@RestController
@RequestMapping("/api/v1/search")
public class WebSearchController {

    private final WebSearchService service;

    public WebSearchController(WebSearchService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<WebSearchResponse> search(@RequestBody SearchRequest req) {
        if (req == null || req.query() == null || req.query().isBlank()) {
            throw new IllegalArgumentException("query 不能为空");
        }
        return ResponseEntity.ok(service.search(req.query(), req.maxResults()));
    }
}
