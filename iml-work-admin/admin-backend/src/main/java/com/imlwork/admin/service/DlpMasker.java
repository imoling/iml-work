package com.imlwork.admin.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 出站前的 DLP 脱敏：手机号、身份证号。流式（ModelStreamRelay）与非流式兜底
 * （ModelProxyService.legacyProxy）共用同一份规则，绝不各写一份。
 *
 * <p><b>必须先把 data: URL 摘出来</b>：脱敏是对整个请求 JSON 做正则替换，而 base64 是
 * 随机字符流，必然出现符合手机号/身份证模式的数字段——直接替换等于把图片数据改坏。
 * 症状极隐蔽：请求 200、路由正确、日志一切正常，唯独模型解不出图、返回空回答
 * （实测：同一张图直连厂商能正确描述，经网关就空）。任何 base64 载荷都会中招，不只图片。
 */
public final class DlpMasker {

    private DlpMasker() {}

    private static final Logger log = LoggerFactory.getLogger(DlpMasker.class);

    /** data: URL（base64 图片/文件）——DLP 必须绕开它，理由见类注释。 */
    private static final Pattern DATA_URL =
            Pattern.compile("data:[a-zA-Z0-9.+/-]+;base64,[A-Za-z0-9+/=]+");

    public static String mask(String payloadJson) {
        // ① 摘出 data: URL，用不可能出现在 JSON 文本里的哨兵占位
        List<String> stash = new ArrayList<>();
        Matcher m = DATA_URL.matcher(payloadJson);
        StringBuilder buf = new StringBuilder();
        while (m.find()) {
            m.appendReplacement(buf, Matcher.quoteReplacement("\u0000DLP" + stash.size() + "\u0000"));
            stash.add(m.group());
        }
        m.appendTail(buf);

        // ② 只对其余文本脱敏
        String sanitized = buf.toString()
                .replaceAll("(?<!\\d)1[3-9]\\d{9}(?!\\d)", "1**********")
                .replaceAll("(?<!\\d)\\d{17}[\\dXx](?!\\d)", "3****************X");
        boolean masked = !sanitized.equals(buf.toString());

        // ③ 原样还原 data: URL
        for (int i = 0; i < stash.size(); i++) {
            sanitized = sanitized.replace("\u0000DLP" + i + "\u0000", stash.get(i));
        }
        if (masked) {
            log.info("[Relay Station] DLP masking applied to request payload.");
        }
        return sanitized;
    }
}
