package com.imlwork.admin.controller;

import com.imlwork.admin.dto.SearchDtos.QuoteItem;
import com.imlwork.admin.dto.SearchDtos.SearchRequest;
import com.imlwork.admin.dto.SearchDtos.WebSearchResponse;
import com.imlwork.admin.service.MarketQuoteService;
import com.imlwork.admin.service.WebSearchService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * 联网检索代理端点：客户端发查询词，后端用保管的密钥调 Tavily/Bing 后回结果，
 * 密钥绝不下发客户端。鉴权走 SecurityConfig 兜底的「登录即可」。
 */
@RestController
@RequestMapping("/api/v1/search")
public class WebSearchController {

    private final WebSearchService service;
    private final MarketQuoteService quoteService;

    public WebSearchController(WebSearchService service, MarketQuoteService quoteService) {
        this.service = service;
        this.quoteService = quoteService;
    }

    @PostMapping
    public ResponseEntity<WebSearchResponse> search(@Valid @RequestBody SearchRequest req) {
        return ResponseEntity.ok(service.search(req.query(), req.maxResults()));
    }

    /** 行情快照直采（腾讯行情接口，服务端代理）：symbols 逗号分隔（sh000001,sz399001…），
     *  缺省=六大指数。当日点位这类硬数字的确定性来源，客户端注入生成素材优先采信。 */
    @GetMapping("/quotes")
    public ResponseEntity<List<QuoteItem>> quotes(@RequestParam(required = false) String symbols) {
        List<String> syms = (symbols == null || symbols.isBlank())
                ? List.of() : List.of(symbols.split(","));
        return ResponseEntity.ok(quoteService.quotes(syms));
    }
}
