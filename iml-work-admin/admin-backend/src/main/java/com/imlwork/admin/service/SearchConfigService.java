package com.imlwork.admin.service;

import com.imlwork.admin.model.SearchConfig;
import com.imlwork.admin.repository.SearchConfigRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

/**
 * 企业联网检索服务配置（单例 row id=default）：读取时懒建默认行；更新时密钥仅在
 * 传入非空值才覆盖（前端回显占位不会清掉已存 Key）。业务与事务在此，控制器只做 HTTP 塑形。
 */
@Service
public class SearchConfigService {

    private static final String ID = "default";

    private final SearchConfigRepository repository;

    public SearchConfigService(SearchConfigRepository repository) {
        this.repository = repository;
    }

    /** 取单例配置；不存在则落一行默认值。 */
    @Transactional
    public SearchConfig getOrCreate() {
        return repository.findById(ID).orElseGet(() -> {
            SearchConfig c = new SearchConfig();
            c.setId(ID);
            return repository.save(c);
        });
    }

    /** 合并更新：provider/引擎缺省归一，数值下限兜底；Key 仅在非空时覆盖。 */
    @Transactional
    public SearchConfig update(SearchConfig update) {
        SearchConfig c = repository.findById(ID).orElseGet(() -> {
            SearchConfig nc = new SearchConfig();
            nc.setId(ID);
            return nc;
        });
        c.setProvider(update.getProvider() == null ? "NONE" : update.getProvider());
        // endpoint 非密钥，直存直显；去掉尾部斜杠（拼 /search 路径时避免双斜杠）
        if (update.getEndpoint() != null) c.setEndpoint(update.getEndpoint().trim().replaceAll("/+$", ""));
        // 仅当传入了新的非空 Key 才覆盖，避免前端回显占位把 Key 清掉。
        if (update.getApiKey() != null && !update.getApiKey().isBlank()) {
            c.setApiKey(update.getApiKey());
        }
        c.setMaxResults(update.getMaxResults() > 0 ? update.getMaxResults() : 5);
        c.setDeepReadCount(Math.max(0, update.getDeepReadCount()));
        c.setBrowserEngine(update.getBrowserEngine() == null ? "ELECTRON" : update.getBrowserEngine());
        c.setUpdatedAt(LocalDateTime.now());
        return repository.save(c);
    }
}
