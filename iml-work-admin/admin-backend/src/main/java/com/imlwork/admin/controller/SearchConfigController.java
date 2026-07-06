package com.imlwork.admin.controller;

import com.imlwork.admin.model.SearchConfig;
import com.imlwork.admin.service.SearchConfigService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * 企业联网检索服务配置。客户端联网检索前拉取这里的配置决定走 API 还是内置浏览器检索。
 */
@RestController
@RequestMapping("/api/v1/search-config")
public class SearchConfigController {

    private final SearchConfigService service;

    public SearchConfigController(SearchConfigService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<SearchConfig> get() {
        return ResponseEntity.ok(service.getOrCreate());
    }

    @PutMapping
    public ResponseEntity<SearchConfig> update(@RequestBody SearchConfig update) {
        return ResponseEntity.ok(service.update(update));
    }
}
