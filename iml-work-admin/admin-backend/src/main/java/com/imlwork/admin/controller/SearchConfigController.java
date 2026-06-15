package com.imlwork.admin.controller;

import com.imlwork.admin.model.SearchConfig;
import com.imlwork.admin.repository.SearchConfigRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;

/**
 * 企业联网检索服务配置。客户端联网检索前拉取这里的配置决定走 API 还是内置浏览器检索。
 */
@RestController
@RequestMapping("/api/v1/search-config")
public class SearchConfigController {

    private static final String ID = "default";
    private final SearchConfigRepository repository;

    public SearchConfigController(SearchConfigRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<SearchConfig> get() {
        return ResponseEntity.ok(repository.findById(ID).orElseGet(() -> {
            SearchConfig c = new SearchConfig();
            c.setId(ID);
            return repository.save(c);
        }));
    }

    @PutMapping
    public ResponseEntity<SearchConfig> update(@RequestBody SearchConfig update) {
        SearchConfig c = repository.findById(ID).orElseGet(() -> {
            SearchConfig nc = new SearchConfig();
            nc.setId(ID);
            return nc;
        });
        c.setProvider(update.getProvider() == null ? "NONE" : update.getProvider());
        // 仅当传入了新的非空 Key 才覆盖，避免前端回显占位把 Key 清掉。
        if (update.getApiKey() != null && !update.getApiKey().isBlank()) {
            c.setApiKey(update.getApiKey());
        }
        c.setMaxResults(update.getMaxResults() > 0 ? update.getMaxResults() : 5);
        c.setDeepReadCount(Math.max(0, update.getDeepReadCount()));
        c.setBrowserEngine(update.getBrowserEngine() == null ? "ELECTRON" : update.getBrowserEngine());
        c.setUpdatedAt(LocalDateTime.now());
        return ResponseEntity.ok(repository.save(c));
    }
}
