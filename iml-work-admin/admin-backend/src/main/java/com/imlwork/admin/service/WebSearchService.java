package com.imlwork.admin.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.imlwork.admin.dto.SearchDtos.SearchPage;
import com.imlwork.admin.dto.SearchDtos.SearchResultItem;
import com.imlwork.admin.dto.SearchDtos.WebSearchResponse;
import com.imlwork.admin.model.SearchConfig;
import com.imlwork.admin.repository.SearchConfigRepository;
import org.springframework.stereotype.Service;

import java.net.ProxySelector;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 企业联网检索代理：用后端保管的 Tavily/Bing 密钥执行检索，密钥绝不下发客户端
 * （对齐「模型统一经中转站、平台不下发密钥」的安全红线）。无 API 配置/失败时返回
 * provider=NONE，客户端据此回退到内置浏览器检索。
 */
@Service
public class WebSearchService {

    private final SearchConfigRepository configRepo;
    // 走企业代理访问外网检索 API：honor -Dhttp(s).proxyHost（dev.sh 已透传）。
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .proxy(ProxySelector.getDefault())
            .build();
    private final ObjectMapper om = new ObjectMapper();

    public WebSearchService(SearchConfigRepository configRepo) {
        this.configRepo = configRepo;
    }

    private static final WebSearchResponse EMPTY = new WebSearchResponse("NONE", List.of(), List.of());

    // 信源分级（对齐主流四档标准，2026-07 用户定版）：
    // T0 核心权威——政府/学术/交易所/国家级官媒/国际组织；T1 专业垂直——按行业分组的专业媒体与智库研报；
    // T2 一般——未识别域名默认档；T3 UGC/自媒体——问答/公众号/社交/个人号。
    // 教训：自媒体"复盘"常滞后一天且互相转抄，数字从它们采信是「7月17日报告用了7月16日数据」事故的温床。
    // 客户端 web-search-core.ts 的 sourceTier 与此同构（素材标注权威级），改一边必须同步另一边。
    private static final String[] TIER_OFFICIAL = {
            ".gov.cn", ".edu.cn", "sse.com.cn", "szse.cn", "bse.cn",          // 政府/高校/交易所
            "xinhuanet.com", "news.cn", "people.com.cn", "cctv.com", "cnr.cn",
            "gmw.cn", "chinanews.com", "china.com.cn", "ce.cn",               // 国家级官媒
            "cnki.net", "nature.com", "science.org", "ieee.org", "nih.gov",   // 学术期刊/数据库
            "who.int", "un.org", "worldbank.org", "imf.org"                   // 国际组织
    };
    private static final String[] TIER_PRO = {
            // 金融/证券/财经
            "stcn.com", "cnstock.com", "cs.com.cn", "caixin.com", "yicai.com", "21jingji.com",
            "jiemian.com", "wallstreetcn.com", "cls.cn", "nbd.com.cn", "eastmoney.com",
            "10jqka.com.cn", "finance.sina.com.cn", "cngold.org", "hexun.com", "jrj.com.cn",
            "cnfol.com", "bloomberg.com", "reuters.com", "ft.com",
            // 科技/AI
            "36kr.com", "tmtpost.com", "leiphone.com", "jiqizhixin.com", "qbitai.com",
            "infoq.cn", "geekpark.net", "techcrunch.com", "theverge.com",
            // 综合新闻专业媒体
            "bjnews.com.cn", "thepaper.cn", "caijing.com.cn",
            // 咨询/智库/行业研报
            "mckinsey.com", "bcg.com", "gartner.com", "idc.com", "iresearch.com.cn",
            "analysys.cn", "iyiou.com", "qianzhan.com", "chyxx.com", "199it.com", "cbndata.com",
            "askci.com", "chinairn.com",
            // 医疗健康
            "dxy.cn", "cn-healthcare.com", "medsci.cn", "pharmnet.com.cn",
            // 汽车 / 教育 / 能源 / 地产
            "gasgoo.com", "d1ev.com", "eol.cn", "jiemodui.com", "bjx.com.cn", "cricchina.com",
            // 体育（垂直资讯，赛事赛果时效性强于综合门户）
            "zhibo8.cc", "dongqiudi.com", "titan24.com"
    };
    private static final String[] TIER_UGC = {
            "zhihu.com", "baijiahao.baidu.com", "xueqiu.com", "jianshu.com", "csdn.net", "sohu.com",
            "163.com/dy", "toutiao.com", "weibo.com", "tieba.baidu.com", "aigupiao.com",
            "bilibili.com", "douyin.com", "zhuanlan.",
            // 问答/公众号/用户编辑百科也是自媒体（实锤：知乎问答、百度知道、公众号复盘挤满行情题前排）
            "zhidao.baidu.com", "mp.weixin.qq.com", "wenda.so.com", "iask.sina.com.cn", "baike.baidu.com",
            // 专业站的 UGC 子域（先于专业档判定，实现子域覆盖）：东财股吧/博客/财富号、新浪博客
            "guba.eastmoney.com", "blog.eastmoney.com", "caifuhao.eastmoney.com", "blog.sina.com.cn",
            // SEO 问答农场/题库/网文站（2026-07 基准实锤混进事实检索前排）：按自媒体档降权
            "justanswer.com", "easylearn.baidu.com", "fanqienovel.com", "reddit.com"
    };
    // 排序权重：档间距小于壳页(15)/错日期(20)/题旨(18)罚分——分级定优先次序，硬伤仍能跨档沉底；
    // UGC 单独拉大到 22，保证它压不过任何更高档的正常结果。
    private static final int[] TIER_WEIGHT = {0, 6, 12, 22};
    // 摘要保留长度：长尾事实的答案（人名/日期/型号/名次）常在摘要靠后处，200 字截断会把答案切掉——
    // 客户端在深读失败时以摘要作答（snippet 兜底），摘要越完整、可直接答对的长尾题越多（2026-07 Round3）。
    private static final int SNIPPET_LEN = 420;
    private static final String[] TIER_LABEL = {"权威", "专业", "一般", "自媒体"};

    /** 生效中的分级名单：默认内置，管理端可经 SearchConfig.sourceTiers（JSON）按行业覆盖。 */
    private record Tiers(String[] official, String[] pro, String[] ugc) { }
    private static final Tiers DEFAULT_TIERS = new Tiers(TIER_OFFICIAL, TIER_PRO, TIER_UGC);
    private volatile String tiersRaw;
    private volatile Tiers tiersParsed = DEFAULT_TIERS;

    private static String[] arrOrDefault(JsonNode n, String[] dflt) {
        if (n == null || !n.isArray()) return dflt;
        List<String> out = new ArrayList<>();
        for (JsonNode x : n) { String s = x.asText("").trim().toLowerCase(); if (!s.isEmpty()) out.add(s); }
        return out.isEmpty() ? dflt : out.toArray(new String[0]);
    }

    private Tiers tiersOf(SearchConfig cfg) {
        String raw = cfg == null ? null : cfg.getSourceTiers();
        if (raw == null || raw.isBlank()) return DEFAULT_TIERS;
        if (raw.equals(tiersRaw)) return tiersParsed;      // 单条缓存：配置不变不重复解析
        try {
            JsonNode n = om.readTree(raw);
            Tiers t = new Tiers(arrOrDefault(n.path("official"), TIER_OFFICIAL),
                    arrOrDefault(n.path("pro"), TIER_PRO), arrOrDefault(n.path("ugc"), TIER_UGC));
            tiersRaw = raw; tiersParsed = t;
            return t;
        } catch (Exception e) {
            return DEFAULT_TIERS;   // 配置 JSON 坏了退内置默认，不让检索挂掉
        }
    }

    private static String hostOf(String url) {
        try { String h = URI.create(url).getHost(); return h == null ? "" : h.toLowerCase(); }
        catch (Exception e) { return ""; }
    }

    /** 域名条目匹配：".gov.cn"=主机后缀；"zhuanlan."=主机前缀；含"/"=整 URL 包含（163.com/dy 网易号）；
     *  其余=主机全等或以 ".域名" 结尾。不能用裸 contains——血泪：insurance.cngold.org 含子串 "ce.cn"
     *  被误判成中国经济网权威档。客户端 web-search-core.ts 的 domainHit 与此同构。 */
    private static boolean domainHit(String url, String host, String d) {
        if (d.indexOf('/') >= 0) return url.contains(d);
        if (d.startsWith(".")) return host.endsWith(d);
        if (d.endsWith(".")) return host.startsWith(d);
        return host.equals(d) || host.endsWith("." + d);
    }

    private static int tierOf(String url, Tiers t) {
        String u = url == null ? "" : url.toLowerCase();
        String h = hostOf(u);
        for (String d : t.official()) if (domainHit(u, h, d)) return 0;
        for (String d : t.ugc()) if (domainHit(u, h, d)) return 3;   // UGC 先于专业判：网易号/知乎专栏等有交叠
        for (String d : t.pro()) if (domainHit(u, h, d)) return 1;
        return 2;
    }

    // 栏目/首页型页面：权威站的「XX频道/股票首页/行情中心」是导航壳，正文全是链接与行情噪声，
    // 深读它等于白读（实锤：查"A股行情"第一名是东方财富【港股频道】栏目页）。标题命中壳词、
    // 或 URL 路径太浅（无具体文章 slug）→ 同权威档内降权，深读自然绕开。
    private static final Pattern HUB_TITLE = Pattern.compile("频道|首页|导航|行情中心|栏目|走势图|专题|网站地图");

    private static boolean looksLikeHub(String url, String title) {
        if (title != null && HUB_TITLE.matcher(title).find()) return true;
        try {
            String path = URI.create(url).getPath();
            if (path == null) return true;
            String p = path.replaceAll("/+$", "");
            return p.chars().filter(c -> c == '/').count() <= 1 && !p.matches(".*\\d{4,}.*");
        } catch (Exception e) { return false; }
    }

    // 日期不符降权：请求点名了具体日期（如 7月17日）时，标题里写着**另一天**的结果
    // （自媒体/研报复盘常滞后一天）直接沉底——「7月16日收市报告」混进 7月17日 复盘素材的事故根子。
    private static final Pattern CN_DATE = Pattern.compile("(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日");
    private static final Pattern A_YEAR = Pattern.compile("(20\\d{2})");
    // 页面/请求里的完整日期（2026-07-17 / 2026/7/17 / 2026年7月17日）
    private static final Pattern FULL_DATE = Pattern.compile("(20\\d{2})\\s*[-/年]\\s*(\\d{1,2})\\s*[-/月]\\s*(\\d{1,2})");

    private static String firstDate(String s) {
        if (s == null) return "";
        Matcher m = CN_DATE.matcher(s);
        return m.find() ? (m.group(1) + "月" + m.group(2) + "日") : "";
    }

    private static String firstYear(String s) {
        if (s == null) return "";
        Matcher m = A_YEAR.matcher(s);
        return m.find() ? m.group(1) : "";
    }

    private static java.time.LocalDate parseFullDate(String s) {
        if (s == null) return null;
        Matcher m = FULL_DATE.matcher(s);
        while (m.find()) {
            try {
                int y = Integer.parseInt(m.group(1)), mo = Integer.parseInt(m.group(2)), d = Integer.parseInt(m.group(3));
                if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return java.time.LocalDate.of(y, mo, d);
            } catch (Exception ignored) { }
        }
        return null;
    }

    // URL 里的日期指纹：新闻 CMS 常把发布日期编进路径（/20260114A04LH900、/2026-01-14/、/2026/01/14/）。
    // 标题不带日期的旧文只有这一处信号可提前识破（实锤：new.qq.com/rain/a/20260114... 混进 7月17日 素材）。
    private static final Pattern URL_DATE = Pattern.compile("(20\\d{2})[-/]?(0[1-9]|1[0-2])[-/]?(0[1-9]|[12]\\d|3[01])");

    private static java.time.LocalDate urlDate(String url) {
        if (url == null) return null;
        Matcher m = URL_DATE.matcher(url);
        while (m.find()) {
            try {
                return java.time.LocalDate.of(Integer.parseInt(m.group(1)),
                        Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
            } catch (Exception ignored) { }
        }
        return null;
    }

    // 题旨重合闸的词元化：CJK/字母数字 2-gram（空格断词，跨词不连）。
    private static java.util.Set<String> bigrams(String s) {
        java.util.Set<String> out = new java.util.HashSet<>();
        if (s == null) return out;
        for (String w : s.replaceAll("[^\\u4e00-\\u9fffA-Za-z0-9]", " ").split("\\s+")) {
            for (int i = 0; i + 1 < w.length(); i++) out.add(w.substring(i, i + 2).toLowerCase());
        }
        return out;
    }

    // 查询只到"年+月"粒度时（如"2026年7月 大模型 动态"）的月份指纹：全日期闸和年份闸都够不着
    // 同年异月的旧文（实锤：new.qq.com/.../20260103... 混进"2026年7月"素材前排）。
    private static final Pattern YEAR_MONTH = Pattern.compile("(20\\d{2})\\s*[-/年]\\s*(\\d{1,2})\\s*月?");

    private static java.time.YearMonth parseYearMonth(String s) {
        if (s == null) return null;
        Matcher m = YEAR_MONTH.matcher(s);
        while (m.find()) {
            int mo = Integer.parseInt(m.group(2));
            if (mo >= 1 && mo <= 12) return java.time.YearMonth.of(Integer.parseInt(m.group(1)), mo);
        }
        return null;
    }

    // 从查询里剥掉日期成分，剩下的才是"问的是什么事"。
    private static String stripDates(String s) {
        return s == null ? "" : s
                .replaceAll("20\\d{2}\\s*[-/年]?", " ")
                .replaceAll("\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]?", " ")
                .replaceAll("\\d{1,2}\\s*[月日号]", " ");
    }

    /** 综合排序分：越小越靠前。权威度 ×10；壳页 +15、错日期/错年份 +20——都要压过一个信源档位
     *  （权威站的壳页/隔日复盘/陈年旧文，比一般站的当日正文更没用，不能靠域名撑在前排）。
     *  错年份单独查：标题只写「7月17日」不带年份时，月日核对拦不住 2014 年的同月日旧文——
     *  只要标题/摘要里出现与请求不同的年份就沉底（真实事故：一财 2014 年「股市盘前预测(7月17日)」混进前排）。 */
    private static int rankScore(String query, SearchResultItem r, Tiers t) {
        int s = TIER_WEIGHT[tierOf(r.url(), t)];
        if (looksLikeHub(r.url(), r.title())) s += 15;
        String qd = firstDate(query);
        if (!qd.isEmpty()) {
            String td = firstDate(r.title());
            if (!td.isEmpty() && !td.equals(qd)) s += 20;
        }
        String qy = firstYear(query);
        if (!qy.isEmpty()) {
            String ty = firstYear((r.title() == null ? "" : r.title()) + " " + (r.snippet() == null ? "" : r.snippet()));
            if (!ty.isEmpty() && !ty.equals(qy)) s += 20;
        }
        // URL 日期指纹核对：路径里编着发布日期的旧文（标题/摘要都不带年份时前两道闸全拦不住）
        java.time.LocalDate ud = urlDate(r.url());
        if (ud != null) {
            java.time.LocalDate qfull = parseFullDate(query);
            java.time.YearMonth qym = parseYearMonth(query);
            if (qfull != null && Math.abs(java.time.temporal.ChronoUnit.DAYS.between(ud, qfull)) > 1) s += 20;
            else if (qfull == null && qym != null && !java.time.YearMonth.from(ud).equals(qym)) s += 20;
            else if (qfull == null && qym == null && !qy.isEmpty() && ud.getYear() != Integer.parseInt(qy)) s += 20;
        }
        // 题旨重合闸：标题带对了日期、又来自权威域，但说的完全是另一件事的结果
        // （个股股东会公告/开庭公告——标题就写着"2026年7月17日"）会靠日期+域名双加分冲到前排。
        // 查询剥掉日期后的内容 2-gram 与标题+摘要一个不沾 → 大概率"同日期不同事"，沉底。
        java.util.Set<String> qb = bigrams(stripDates(query));
        if (!qb.isEmpty()) {
            java.util.Set<String> tb = bigrams(
                    (r.title() == null ? "" : r.title()) + " " + (r.snippet() == null ? "" : r.snippet()));
            boolean hit = false;
            for (String g : qb) if (tb.contains(g)) { hit = true; break; }
            if (!hit) s += 18;
        }
        return s;
    }

    // 检索结果短时缓存：同一查询在缺口补查/失败重试/多技能并发里常被重复发起——重复打引擎
    // 既慢又触发风控（实锤 2026-07-17：高频查询把 baidu 打进验证码封禁 1 小时，检索通道全空）。
    private static final long CACHE_TTL_MS = 8 * 60_000L;
    private record CacheEntry(long ts, WebSearchResponse resp) { }
    private final java.util.concurrent.ConcurrentHashMap<String, CacheEntry> cache = new java.util.concurrent.ConcurrentHashMap<>();

    public WebSearchResponse search(String query, Integer maxOverride) {
        SearchConfig cfg = configRepo.findById("default").orElse(null);
        if (cfg == null) return EMPTY;
        String provider = cfg.getProvider() == null ? "NONE" : cfg.getProvider();
        String key = cfg.getApiKey();
        int max = maxOverride != null && maxOverride > 0 ? maxOverride
                : (cfg.getMaxResults() > 0 ? cfg.getMaxResults() : 5);
        int deep = Math.max(0, cfg.getDeepReadCount());
        // key 掺入分级名单指纹：管理端改完信源配置立刻生效，不被 8 分钟缓存压住
        String ck = provider + "|" + max + "|" + deep + "|"
                + (cfg.getSourceTiers() == null ? 0 : cfg.getSourceTiers().hashCode()) + "|" + query;
        CacheEntry ce = cache.get(ck);
        if (ce != null && System.currentTimeMillis() - ce.ts() < CACHE_TTL_MS) return ce.resp();
        Tiers tiers = tiersOf(cfg);
        WebSearchResponse resp = EMPTY;
        try {
            // SearXNG：自托管聚合检索，只要 endpoint、不要密钥
            if ("SEARXNG".equals(provider)) {
                String ep = cfg.getEndpoint();
                if (ep == null || ep.isBlank()) return EMPTY;
                resp = searxng(query, ep.trim().replaceAll("/+$", ""), max, deep, tiers);
            } else if ("HYBRID".equals(provider)) {
                // 混合通道：SearXNG 打头阵（免费、多引擎），素材薄/无高信源时才烧 Tavily 额度兜底。
                // Tavily 的 raw_content 直出正文并入 pages——比免费通道深读干净，且省客户端反爬链路。
                String ep = cfg.getEndpoint();
                if (ep != null && !ep.isBlank()) {
                    try { resp = searxng(query, ep.trim().replaceAll("/+$", ""), max, deep, tiers); }
                    catch (Exception e2) { resp = EMPTY; }
                }
                if (needsTavilyBoost(resp) && key != null && !key.isBlank()) {
                    try { resp = mergeResponses(resp, tavily(query, key, max, deep, tiers)); }
                    catch (Exception e2) { /* Tavily 失败保留 SearXNG 结果，绝不因兜底把主通道也丢了 */ }
                }
            } else if (key != null && !key.isBlank()) {
                if ("TAVILY".equals(provider)) resp = tavily(query, key, max, deep, tiers);
                else if ("BING".equals(provider)) resp = bing(query, key, max, deep, tiers);
            }
        } catch (Exception e) {
            // 检索失败 → 返回空，客户端回退浏览器检索（不抛错、不泄漏 key）。
            return EMPTY;
        }
        if (!resp.results().isEmpty()) {
            if (cache.size() > 200) {
                final long now = System.currentTimeMillis();
                cache.entrySet().removeIf(en -> now - en.getValue().ts() > CACHE_TTL_MS);
            }
            cache.put(ck, new CacheEntry(System.currentTimeMillis(), resp));
        }
        return resp;
    }

    /** SearXNG（自托管聚合检索）：JSON API 返回结果与摘要，正文由**服务端**深读随响应带回
     *  （客户端网络常被代理/反爬卡住——检索既然在服务端能成，正文也在服务端取才对称）。
     *  需在其 settings.yml 开启 search.formats: [html, json]。 */
    /** 混合通道的兜底触发：结果太薄（<3 条）或没有任何权威/专业级信源——
     *  免费通道拿得到像样素材就不动 Tavily 额度，多跳补查的大多数跳数走免费通道。 */
    private static boolean needsTavilyBoost(WebSearchResponse r) {
        if (r.results().size() < 3) return true;
        for (SearchResultItem x : r.results()) {
            if ("权威".equals(x.tier()) || "专业".equals(x.tier())) return false;
        }
        return true;
    }

    /** 合并两通道：SearXNG 原序保留，Tavily 新 URL 追加；结果与页面均按 URL 去重。 */
    private static WebSearchResponse mergeResponses(WebSearchResponse a, WebSearchResponse b) {
        List<SearchResultItem> results = new ArrayList<>(a.results());
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (SearchResultItem x : a.results()) seen.add(x.url());
        for (SearchResultItem x : b.results()) if (seen.add(x.url())) results.add(x);
        List<SearchPage> pages = new ArrayList<>(a.pages());
        java.util.Set<String> seenP = new java.util.HashSet<>();
        for (SearchPage p : a.pages()) seenP.add(p.url());
        for (SearchPage p : b.pages()) if (seenP.add(p.url())) pages.add(p);
        return new WebSearchResponse("HYBRID", results, pages);
    }

    /** 查询语言自适应：CJK 字符为零或远少于拉丁字母 → 按英文查询（en-US）。
     *  硬编码 zh-CN 时英文长尾查询被国内引擎按中文语料召回，SERP 全是题库/SEO/网文噪声
     *（2026-07 基准实锤：World Cup 查询混进 Reddit 热水器帖、HR7004 补查拉回博物馆页）。 */
    private static String searchLang(String query) {
        int cjk = 0, letters = 0;
        for (int i = 0; i < query.length(); i++) {
            char c = query.charAt(i);
            if (c >= 0x4E00 && c <= 0x9FFF) cjk++;
            else if (Character.isLetter(c)) letters++;
        }
        return (cjk == 0 || cjk * 9 < letters) ? "en-US" : "zh-CN";
    }

    private WebSearchResponse searxng(String query, String endpoint, int max, int deep, Tiers tiers) throws Exception {
        String url = endpoint + "/search?q=" + URLEncoder.encode(query, StandardCharsets.UTF_8)
                + "&format=json&language=" + searchLang(query) + "&safesearch=0";
        // 空结果重试（指数退避，最多 3 次）：国内引擎（sogou/quark/360）连续请求会被上游 CAPTCHA 挂起，
        // 或宿主到引擎的网络在突发出站下间歇 ConnectError → 同一查询偶发返回 0 条（实锤：同一检索词
        // 单发有 8 条、并发/网络抖动时得 0）。逐次退避 1.2s→2.5s 让引擎恢复或换未挂起引擎，
        // 通常一两次即有结果。对真实弱网/突发用户请求同样是净增益。
        JsonNode d = null;
        final long[] backoffMs = { 1200, 2500 };
        for (int attempt = 0; attempt < 3; attempt++) {
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(20))
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() / 100 != 2) throw new RuntimeException("SearXNG HTTP " + res.statusCode());
            d = om.readTree(res.body());
            if (d.path("results").size() > 0) break;
            if (attempt < backoffMs.length) {
                try { Thread.sleep(backoffMs[attempt]); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
        }
        List<SearchResultItem> results = new ArrayList<>();
        java.util.Set<String> seenUrls = new java.util.HashSet<>();
        java.util.Set<String> seenTitles = new java.util.HashSet<>();
        if (d == null) return EMPTY;   // 中断退出（理论不可达：循环内必赋值）——防御空指针
        for (JsonNode x : d.path("results")) {
            if (results.size() >= max * 2) break;   // 多收一倍候选，供权威度重排后再截断
            String u = x.path("url").asText("");
            // 同页去重按「主机+路径」归一（http/https、尾斜杠、query 参数不同的同一页，聚合引擎常重复给）
            String urlKey = u.replaceFirst("^https?://", "").replaceAll("[?#].*$", "").replaceAll("/+$", "");
            if (u.isBlank() || !seenUrls.add(urlKey)) continue;
            // 跨站同稿去重：同一条公告/通稿被多个站转载（实锤：吉林敖东股东会两个站各一条），
            // URL 归一拦不住 → 标题去掉标点/站名后缀取前 24 字作指纹
            String title = x.path("title").asText("");
            String titleKey = title.replaceAll("[^\\u4e00-\\u9fffA-Za-z0-9]", "");
            titleKey = titleKey.substring(0, Math.min(24, titleKey.length()));
            if (titleKey.length() >= 8 && !seenTitles.add(titleKey)) continue;
            String content = x.path("content").asText("");
            results.add(new SearchResultItem(title, u,
                    content.length() > SNIPPET_LEN ? content.substring(0, SNIPPET_LEN) : content,
                    TIER_LABEL[tierOf(u, tiers)]));
        }
        // 综合重排（稳定排序，同分保持相关性原序）：权威优先 + 壳页降权 + 日期冲突沉底，再截断到 max。
        // 深读跟着顺序走——权威、非壳页、日期相符的文章先被读到。
        final String q = query;
        results.sort(java.util.Comparator.comparingInt(r -> rankScore(q, r, tiers)));
        if (results.size() > max) results = new ArrayList<>(results.subList(0, max));
        return new WebSearchResponse("SEARXNG", results, serverDeepRead(query, results, deep, tiers));
    }

    /** 服务端深读：并行抓取头部结果的网页正文（浏览器 UA + 中文站字符集嗅探 + 标签剥离）。
     *  单篇失败静默跳过；返回不足时客户端仍会用本机离屏浏览器兜底细读——双通道，谁通走谁。
     *  请求点名具体日期时，按**页面自述的发布时间**二次核对（标题月日核对拦不住"2014年7月17日"
     *  这种跨年同月日旧文——真实事故），偏离超 1 天的页弃读（±1 天放行：盘前/隔夜综述常前一晚发）。 */
    private List<SearchPage> serverDeepRead(String query, List<SearchResultItem> results, int deep, Tiers tiers) {
        final java.time.LocalDate wantDate = parseFullDate(query);
        final java.time.YearMonth wantYm = wantDate == null ? parseYearMonth(query) : null;
        if (deep <= 0 || results.isEmpty()) return List.of();
        // 深读候选跳过壳页：行情中心/频道首页的数字靠 JS 渲染，静态抓取只得导航噪声——
        // 读它挤占真正文章的名额（实锤：一轮深读 6 篇里 3 篇是"股票首页"）。候选不够时才用壳页凑数。
        // 候选窗口 deep+4：正文质量闸会拒掉壳页/风控壳，多备几个名额留给后面的真文章
        List<SearchResultItem> cands = new ArrayList<>();
        for (SearchResultItem r : results) {
            if (cands.size() >= deep + 4) break;
            if (!looksLikeHub(r.url(), r.title())) cands.add(r);
        }
        for (SearchResultItem r : results) {
            if (cands.size() >= deep + 4) break;
            if (looksLikeHub(r.url(), r.title()) && !cands.contains(r)) cands.add(r);
        }
        List<CompletableFuture<SearchPage>> futures = new ArrayList<>();
        for (SearchResultItem r : cands) {
            final String tierLabel = r.tier() != null ? r.tier() : TIER_LABEL[tierOf(r.url(), tiers)];
            futures.add(CompletableFuture.supplyAsync(() -> fetchPage(r, wantDate, wantYm, tierLabel)));
        }
        List<SearchPage> pages = new ArrayList<>();
        for (CompletableFuture<SearchPage> f : futures) {
            if (pages.size() >= deep) { f.cancel(true); continue; }
            try { SearchPage p = f.get(12, TimeUnit.SECONDS); if (p != null) pages.add(p); }
            catch (Exception ignored) { /* 单篇超时/失败不拖垮整轮 */ }
        }
        return pages;
    }

    private SearchPage fetchPage(SearchResultItem r, java.time.LocalDate wantDate, java.time.YearMonth wantYm, String tierLabel) {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(r.url()))
                    .timeout(Duration.ofSeconds(10))
                    .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
                    .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                    .header("Accept-Language", "zh-CN,zh;q=0.9")
                    .GET().build();
            HttpResponse<byte[]> res = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (res.statusCode() / 100 != 2) return null;
            String ct = res.headers().firstValue("Content-Type").orElse("");
            if (!ct.isBlank() && !ct.contains("html") && !ct.contains("text")) return null;
            String text = htmlToText(res.body(), ct);
            if (text.length() < 120) return null;   // 太短多为反爬壳/跳转页，不当正文
            // 正文质量闸：光看长度会放进两类垃圾——①行情/门户壳页 ②WAF 风控壳（一段 JSON）。
            // 中文字数也不可靠：壳页的"标题汤"上千中文字照样是噪声。真判据是**连续长文段**
            //（中文+数字+标点 50+ 连排）。教训：曾在全文上判、却截头 2600 字运出——门户页深处一段
            // 版权长句骗过闸门，运出去的仍是导航汤。现在**截取窗口从第一个长文段起**（跳过导航前奏，
            // 所有文章页同样受益），并在窗口内复核成文密度。
            String compact = text.replaceAll("\\s+", "");
            if (compact.startsWith("{") || compact.contains("_waf_")) return null;
            long cjk = compact.chars().filter(c -> c >= 0x4E00 && c <= 0x9FFF).count();
            if (cjk < 150) return null;
            Matcher mr = RICH_RUN.matcher(text);
            if (!mr.find()) return null;                       // 全文无成段中文 → 壳
            int start = Math.max(0, mr.start() - 120);          // 留一点标题/语境
            // 发布时间探测窗对准「正文起点之前」：门户站头部导航动辄两三千字（实锤：搜狐体育
            // 2026-02-01 旧文的日期被挤出原先固定的头部 1500 字窗，二月旧闻混进"本周"素材），
            // 而发布时间几乎总在标题与正文之间 → 扫到正文起点后一小段为止，兜底仍保 1500。
            java.time.LocalDate pd = parseFullDate(text.substring(0, Math.min(text.length(), Math.max(1500, start + 300))));
            if (wantDate != null && pd != null
                    && Math.abs(java.time.temporal.ChronoUnit.DAYS.between(pd, wantDate)) > 1) return null;
            // 查询只到"年+月"粒度时按月核对：相差超过一个月才弃（"6月总结"常在7月初发，跨月边界放行）
            if (wantYm != null && pd != null
                    && Math.abs(java.time.temporal.ChronoUnit.MONTHS.between(java.time.YearMonth.from(pd), wantYm)) > 1) return null;
            String win = text.substring(start, Math.min(text.length(), start + 2600));
            int richRuns = 0, maxRun = 0;
            Matcher mw = RICH_RUN.matcher(win);
            while (mw.find()) { richRuns++; maxRun = Math.max(maxRun, mw.group().length()); }
            if (richRuns < 2 && maxRun < 150) return null;      // 窗口内仍不成文 → 壳
            // 标点密度复核：券商名/栏目名列表能凑出"长连排"却没有句读——真文章的窗口必有成句标点
            long wPunct = win.chars().filter(c -> c == '。' || c == '，' || c == '；' || c == '、' || c == '：').count();
            if (wPunct < 8) return null;
            if (pd != null) win = "【页面发布时间：" + pd + "】" + win;
            return new SearchPage(r.url(), r.title(), win, tierLabel);
        } catch (Exception e) { return null; }
    }

    // 连续长文段（中文+数字+中文标点 50 连排以上）——区分"文章正文"与"门户标题汤"的判据
    private static final Pattern RICH_RUN = Pattern.compile("[\\u4e00-\\u9fff0-9\\uFF0C\\u3002\\u3001\\uFF1B\\uFF1A\\uFF08\\uFF09（）%\\.\\-+]{50,}");
    private static final Pattern HEADER_CHARSET = Pattern.compile("charset=([\\w-]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern META_CHARSET = Pattern.compile("charset=[\"']?([\\w-]+)", Pattern.CASE_INSENSITIVE);

    /** HTML → 纯文本：剥 script/style/注释/标签，还原常见实体，压空白。中文站仍有 GBK 存量，按响应头/meta 嗅探字符集。 */
    private String htmlToText(byte[] body, String contentTypeHeader) {
        String cs = "UTF-8";
        Matcher m = HEADER_CHARSET.matcher(contentTypeHeader == null ? "" : contentTypeHeader);
        if (m.find()) cs = m.group(1);
        else {
            String head = new String(body, 0, Math.min(body.length, 2048), StandardCharsets.ISO_8859_1);
            Matcher m2 = META_CHARSET.matcher(head);
            if (m2.find()) cs = m2.group(1);
        }
        String html;
        try { html = new String(body, Charset.forName(cs)); }
        catch (Exception e) { html = new String(body, StandardCharsets.UTF_8); }
        return html.replaceAll("(?is)<(script|style|noscript)[^>]*>.*?</\\1>", " ")
                .replaceAll("(?is)<!--.*?-->", " ")
                .replaceAll("(?i)<br\\s*/?>", "\n")
                .replaceAll("(?s)<[^>]+>", " ")
                .replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
                .replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
                .replaceAll("[ \\t\\x0B\\f\\r]+", " ")
                .replaceAll("\\n{3,}", "\n\n")
                .trim();
    }

    /** Tavily：面向 AI 的检索 API，直接返回结果与正文。 */
    private WebSearchResponse tavily(String query, String key, int max, int deep, Tiers tiers) throws Exception {
        String body = om.writeValueAsString(Map.of(
                "api_key", key, "query", query, "max_results", max, "include_raw_content", true));
        HttpRequest req = HttpRequest.newBuilder(URI.create("https://api.tavily.com/search"))
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() / 100 != 2) throw new RuntimeException("Tavily HTTP " + res.statusCode());
        JsonNode d = om.readTree(res.body());
        List<SearchResultItem> results = new ArrayList<>();
        List<SearchPage> pages = new ArrayList<>();
        int i = 0;
        for (JsonNode x : d.path("results")) {
            String url = x.path("url").asText("");
            String title = x.path("title").asText("");
            String content = x.path("content").asText("");
            String tl = TIER_LABEL[tierOf(url, tiers)];
            results.add(new SearchResultItem(title, url, content.length() > SNIPPET_LEN ? content.substring(0, SNIPPET_LEN) : content, tl));
            if (i < deep) {
                String raw = x.path("raw_content").asText(content);
                String text = raw.replaceAll("\\s+", " ").trim();
                if (text.length() > 2600) text = text.substring(0, 2600);
                if (!text.isBlank()) pages.add(new SearchPage(url, title, text, tl));
            }
            i++;
        }
        return new WebSearchResponse("TAVILY", results, pages);
    }

    /** Bing Web Search API：结果 + 服务端深读正文。 */
    private WebSearchResponse bing(String query, String key, int max, int deep, Tiers tiers) throws Exception {
        String url = "https://api.bing.microsoft.com/v7.0/search?q="
                + URLEncoder.encode(query, StandardCharsets.UTF_8) + "&count=" + max + "&mkt=zh-CN";
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(20))
                .header("Ocp-Apim-Subscription-Key", key)
                .GET()
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() / 100 != 2) throw new RuntimeException("Bing HTTP " + res.statusCode());
        JsonNode d = om.readTree(res.body());
        List<SearchResultItem> results = new ArrayList<>();
        for (JsonNode x : d.path("webPages").path("value")) {
            String u = x.path("url").asText("");
            results.add(new SearchResultItem(x.path("name").asText(""), u, x.path("snippet").asText(""),
                    TIER_LABEL[tierOf(u, tiers)]));
        }
        return new WebSearchResponse("BING", results, serverDeepRead(query, results, deep, tiers));
    }
}
