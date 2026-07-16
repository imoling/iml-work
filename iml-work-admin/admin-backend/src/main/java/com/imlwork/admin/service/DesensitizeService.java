package com.imlwork.admin.service;

import org.springframework.stereotype.Service;

import java.util.*;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Agent Trace 脱敏引擎：分类识别（D1-D15）、分级处理（L1-L3）、分模式（轻度/标准/强）。
 * 对任意文本扫描并替换敏感内容，返回脱敏后文本 + 命中规则统计（不保存敏感原文）。
 */
@Service
public class DesensitizeService {

    public enum Mode { LIGHT, STANDARD, STRONG }

    /** 一条脱敏规则。modes 指定该规则在哪些模式下生效。 */
    private record Rule(String id, String name, String level, Set<Mode> modes, Pattern pattern, Function<Matcher, String> repl) {}

    public record Hit(String rule, String name, String level, int count) {}
    public record Result(String text, List<Hit> hits) {}

    private static final Set<Mode> ALL = EnumSet.allOf(Mode.class);
    private static final Set<Mode> STD_STRONG = EnumSet.of(Mode.STANDARD, Mode.STRONG);
    private static final Set<Mode> STRONG_ONLY = EnumSet.of(Mode.STRONG);

    private final List<Rule> rules = new ArrayList<>();

    public DesensitizeService() {
        // —— L3 高危：全模式（含轻度）都脱敏 ——
        add("D10", "API Key / Token / 凭证", "L3", ALL,
                "(?i)(sk-[A-Za-z0-9]{6,}|Bearer\\s+[A-Za-z0-9._\\-]{8,}|(?:api[_-]?key|token|secret|password|cookie|access[_-]?token)\\s*[:=]\\s*[\"']?[A-Za-z0-9._\\-]{6,})",
                m -> "【已隐藏凭证】");
        add("D13", "数据库连接串", "L3", ALL,
                "(?i)(jdbc:[a-z0-9]+:|mongodb(\\+srv)?:|mysql:|postgres(ql)?:|redis:|sqlserver:)//[^\\s'\"]+",
                m -> "【已隐藏数据库连接】");
        add("D11", "内网地址 / IP", "L3", ALL,
                "((?:10|192\\.168|172\\.(?:1[6-9]|2\\d|3[01]))\\.)\\d{1,3}(?:\\.\\d{1,3}){1,2}",
                m -> m.group(1) + "*.*.*");
        // —— L1 一般敏感：全模式局部打码 ——
        add("D4", "手机号", "L1", ALL,
                "(?<!\\d)(1[3-9]\\d)\\d{4}(\\d{4})(?!\\d)",
                m -> m.group(1) + "****" + m.group(2));
        add("D5", "身份证 / 证件号", "L1", ALL,
                "(?<![0-9Xx])(\\d{4})\\d{10}(\\d{3}[\\dXx])(?![0-9Xx])",
                m -> m.group(1) + "**********" + m.group(2));
        add("D6", "邮箱", "L1", ALL,
                "([A-Za-z0-9])[A-Za-z0-9._%+\\-]*(@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,})",
                m -> m.group(1) + "***" + m.group(2));
        // —— L2 业务敏感：标准 + 强 ——
        // 金额有两种写法，必须都盖住：
        //   ① 带货币符号：¥6,800 / ￥6800 / $1,200.50 / RMB 5000 —— **没有"元"字**
        //   ② 带单位后缀：6,800元 / 5000 元 / 8.5万元 / 3亿
        // 旧正则 "¥?\s?\d+(?:\.\d+)?\s*(?:元|万元|万|亿)" 强制要求单位后缀、且 \d+ 不认千分位逗号，
        // 于是审计里的「预算 ¥6,800」两条都不满足 —— 标准脱敏下金额原样露出，是真漏。
        add("D1", "金额", "L2", STD_STRONG,
                "(?:[¥￥$]|(?i:RMB|CNY))\\s?\\d+(?:,\\d{3})*(?:\\.\\d+)?"
                        + "|\\d+(?:,\\d{3})*(?:\\.\\d+)?\\s*(?:元|万元|万|亿|块钱|块)",
                m -> "***（金额已脱敏）");
        add("D2", "人名 / 职务", "L2", STD_STRONG,
                "[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳唐罗薛伍余米贝姚孟](经理|专员|总监|主管|负责人|工程师|顾问|助理|总裁|董事)",
                m -> "某" + m.group(1));
        add("D9", "账号 / 工号", "L2", STD_STRONG,
                "(?:工号\\s*[:：]?\\s*\\w+|\\buser[_-]\\w+)",
                m -> m.group().startsWith("工号") ? "工号***" : "user_***");
        add("D12", "文件路径", "L2", STD_STRONG,
                "(/Users/|/home/)[^/\\s]+/",
                m -> m.group(1) + "***/");
        add("D3", "技术 / 接口参数", "L2", STD_STRONG,
                "(?i)(?:temperature|max[_-]?tokens|top[_-]?p|endpoint|baseUrl)\\s*[:=]\\s*[\"']?[^\\s,，'\"]+",
                m -> "【技术参数已隐藏】");
        // —— 强脱敏专用：泛化客户名 / 详细地址 ——
        add("D8", "企业 / 客户名称", "L2", STRONG_ONLY,
                "[\\u4e00-\\u9fa5A-Za-z0-9]{2,12}(科技|集团|有限公司|股份有限公司|有限责任公司|实业|制造|电子|网络|银行)",
                m -> "某企业");
        add("D7", "详细地址", "L2", STRONG_ONLY,
                "\\d+号(?:[\\u4e00-\\u9fa5\\d]{0,8}(?:室|栋|楼|单元|号楼))?",
                m -> "***");
    }

    private void add(String id, String name, String level, Set<Mode> modes, String regex, Function<Matcher, String> repl) {
        rules.add(new Rule(id, name, level, modes, Pattern.compile(regex), repl));
    }

    /** 对一段文本按模式脱敏，返回脱敏后文本与命中统计。 */
    public Result desensitize(String text, Mode mode) {
        if (text == null || text.isEmpty()) return new Result(text, List.of());
        String out = text;
        Map<String, Hit> hits = new LinkedHashMap<>();
        for (Rule r : rules) {
            if (!r.modes().contains(mode)) continue;
            Matcher m = r.pattern().matcher(out);
            StringBuilder sb = new StringBuilder();
            int count = 0;
            while (m.find()) {
                count++;
                m.appendReplacement(sb, Matcher.quoteReplacement(r.repl().apply(m)));
            }
            m.appendTail(sb);
            if (count > 0) {
                out = sb.toString();
                Hit prev = hits.get(r.id());
                hits.put(r.id(), new Hit(r.id(), r.name(), r.level(), (prev == null ? 0 : prev.count()) + count));
            }
        }
        return new Result(out, new ArrayList<>(hits.values()));
    }

    public Mode parseMode(String s) {
        if (s == null) return Mode.STANDARD;
        try { return Mode.valueOf(s.trim().toUpperCase()); } catch (Exception e) { return Mode.STANDARD; }
    }
}
