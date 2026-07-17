package com.imlwork.admin.service;

import com.imlwork.admin.dto.SearchDtos.QuoteItem;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.Charset;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 行情数据接口直采（腾讯 qt.gtimg.cn，免密钥公开接口，服务端代理）。
 * 为什么要有它：当日收盘点位/涨跌幅这类硬数字，新闻检索只能拿到转述——旧文自称"今日"、
 * 自媒体隔日转抄都出过事故（2025-07-17 金投网旧文的 3516.83 被当作 2026-07-17 收盘写进 PPT）。
 * 接口直采是确定性数据源：客户端把快照注入生成素材并标注「权威·接口直采」，采信红线优先取它。
 */
@Service
public class MarketQuoteService {

    /** 合法代码：sh/sz/bj + 6 位数字（防 URL 注入）。 */
    private static final Pattern SYMBOL = Pattern.compile("(sh|sz|bj)\\d{6}");
    /** 缺省快照集：上证指数/深证成指/创业板指/沪深300/科创50/北证50。 */
    private static final List<String> DEFAULT_SYMBOLS = List.of(
            "sh000001", "sz399001", "sz399006", "sh000300", "sh000688", "bj899050");
    private static final Charset GBK = Charset.forName("GBK");

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public List<QuoteItem> quotes(List<String> symbols) {
        List<String> syms = (symbols == null || symbols.isEmpty()) ? DEFAULT_SYMBOLS
                : symbols.stream().map(s -> s.trim().toLowerCase())
                        .filter(s -> SYMBOL.matcher(s).matches()).distinct().limit(20).toList();
        if (syms.isEmpty()) return List.of();
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create("http://qt.gtimg.cn/q=" + String.join(",", syms)))
                    .timeout(Duration.ofSeconds(8))
                    .header("User-Agent", "Mozilla/5.0")
                    .GET().build();
            HttpResponse<byte[]> res = http.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (res.statusCode() / 100 != 2) return List.of();
            String body = new String(res.body(), GBK);
            List<QuoteItem> out = new ArrayList<>();
            for (String sym : syms) {
                QuoteItem q = parseOne(sym, body);
                if (q != null) out.add(q);
            }
            return out;
        } catch (Exception e) {
            // 行情源不通 → 返回空，调用方按"没有快照"走纯检索路径（不抛错拖垮备料）
            return List.of();
        }
    }

    /** 腾讯行情返回体形如 v_sh000001="1~上证指数~000001~3764.15~3882.41~...";
     *  字段按 ~ 切：[1]名称 [3]现价 [4]昨收 [30]行情时间(yyyyMMddHHmmss) [31]涨跌 [32]涨跌幅%。
     *  单代码解析失败跳过，不拖垮整批。 */
    private static QuoteItem parseOne(String sym, String body) {
        try {
            Matcher m = Pattern.compile("v_" + sym + "=\"([^\"]*)\"").matcher(body);
            if (!m.find()) return null;
            String[] f = m.group(1).split("~", -1);
            if (f.length < 33 || f[3].isBlank()) return null;
            double price = Double.parseDouble(f[3]);
            double prev = f[4].isBlank() ? 0 : Double.parseDouble(f[4]);
            double chg = f[31].isBlank() ? price - prev : Double.parseDouble(f[31]);
            double pct = f[32].isBlank() ? (prev == 0 ? 0 : chg / prev * 100) : Double.parseDouble(f[32]);
            String ts = f[30];
            String time = ts.length() >= 14
                    ? ts.substring(0, 4) + "-" + ts.substring(4, 6) + "-" + ts.substring(6, 8)
                      + " " + ts.substring(8, 10) + ":" + ts.substring(10, 12) + ":" + ts.substring(12, 14)
                    : ts;
            return new QuoteItem(sym, f[1], price, prev, chg, pct, time);
        } catch (Exception e) {
            return null;
        }
    }
}
