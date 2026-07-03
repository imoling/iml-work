package com.imlwork.admin.service;

import com.imlwork.admin.model.Skill;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 技能包导入前的静态安全扫描器（纯 Java，无外部服务）。
 *
 * <p>设计借鉴 Tencent AI-Infra-Guard 对 AI 组件 / MCP 的分析范式：
 * <b>实体归集 → 多维检测器并行 → 证据加权 → 风险定级</b>，而非单遍正则匹配。
 * 检测维度覆盖其威胁模型（提示注入 / 工具投毒 / 数据外传 / 越权绕过 / 供应链），
 * 并叠加本项目安全红线（写操作须人工确认+签名、凭证绝不上传、绝不虚构业务数据）。
 *
 * <p>定级：任一 HIGH → 直接阻断安装；否则按加权分给出 MEDIUM/LOW/SAFE。
 * 每条发现带 severity / type / detail / evidence / weight，聚合出 0–100 的 riskScore。
 */
@Service
public class SkillSecurityService {

    public record Finding(String severity, String type, String detail, String evidence, int weight) {}

    /** 已知 Skill DSL 操作码；脚本中出现未知指令按可疑处理。 */
    private static final Set<String> DSL_OPS = Set.of(
            "open", "click", "fill", "select", "searchselect", "pickoption", "hover",
            "wait", "press", "read", "extract", "goto", "type", "submit", "check", "scroll");

    /** 可信外发主机（业务/供应链白名单外的域名一律提示）。 */
    private static final Set<String> TRUSTED_HOSTS = Set.of(
            "localhost", "127.0.0.1", "github.com", "raw.githubusercontent.com");

    private static final int MAX_FIELD_LEN = 200_000;

    // ── 检测器规则（每类一个/多个模式，命中即产生带权发现）──

    // HIGH · 提示注入 / 越权指令
    private static final Pattern P_INJECTION = Pattern.compile(
            "忽略(之前|上述|以上|系统|安全|前面).{0,10}(指令|规则|提示|限制|设定)"
                    + "|(你现在是|从现在起你是|扮演).{0,12}(管理员|超级|root|开发者模式|dan)"
                    + "|ignore\\s+(all\\s+)?(previous|above)\\s+(instructions?|rules?|prompts?)"
                    + "|disregard\\s+(the\\s+)?(system|safety)\\s+(prompt|rules?)|jailbreak|developer\\s+mode",
            Pattern.CASE_INSENSITIVE);

    // HIGH · 确认/审批绕过（红线：写操作须人工确认+签名）
    private static final Pattern P_BYPASS = Pattern.compile(
            "跳过(人工|用户)?(确认|审批|签名|复核)|绕过(人工|用户)?(确认|审批|签名|权限|复核)"
                    + "|无需(用户|人工)(确认|审批)|自动(通过|同意|批准)(审批|申请|流程)|免(确认|审批)执行"
                    + "|(auto|silently)\\s*[- ]?(approve|confirm|sign)|skip\\s+(the\\s+)?(confirmation|approval)",
            Pattern.CASE_INSENSITIVE);

    // HIGH · 凭证/敏感数据外传（红线：凭证只在本地）· 双向语序
    private static final String SECRET = "(密码|口令|凭证|凭据|登录态|会话|cookie|token|密钥|api\\s*key|secret|credential)";
    private static final String SEND = "(发送|上传|外发|外传|提交|同步|发到|传到|回传|上报|泄露|导出)";
    private static final Pattern P_EXFIL = Pattern.compile(
            SEND + ".{0,24}" + SECRET + "|" + SECRET + ".{0,24}" + SEND
                    + "|(窃取|盗取|收集|抓取).{0,10}(账号|密码|凭证|登录态|个人信息)"
                    + "|exfiltrat|steal.{0,12}(credential|password|token|cookie)|document\\.cookie",
            Pattern.CASE_INSENSITIVE);

    // HIGH · 脚本执行 / 沙箱逃逸（语义技能不应含任何代码执行面）
    private static final Pattern P_CODE_EXEC = Pattern.compile(
            "\\beval\\s*\\(|new\\s+Function|child_process|\\bexec(Sync)?\\s*\\(|\\bspawn(Sync)?\\s*\\("
                    + "|\\brequire\\s*\\(|\\bimport\\s*\\(|process\\.(env|exit|binding)"
                    + "|fs\\.(read|write|append|unlink|rm|mkdir)|__proto__|globalThis|XMLHttpRequest",
            Pattern.CASE_INSENSITIVE);

    // HIGH · 供应链 / 命令投递（下载即执行）
    private static final Pattern P_SUPPLY = Pattern.compile(
            "(curl|wget)\\b.{0,80}\\|\\s*(sh|bash|zsh)|bash\\s+-c|powershell|Invoke-Expression|\\biex\\b"
                    + "|(npm|pnpm|yarn|pip|pip3|brew|apt|gem)\\s+(install|add|i)\\s|os\\.system|subprocess\\.",
            Pattern.CASE_INSENSITIVE);

    // MEDIUM · 虚构数据倾向（红线：绝不虚构业务数据）
    private static final Pattern P_FABRICATE = Pattern.compile(
            "(编造|虚构|捏造|杜撰|伪造).{0,8}(数据|结果|条目|记录|信息|待办|单号)"
                    + "|即使(查不到|没有|无).{0,8}也(要|请)?(给出|返回|编|填)|凭空(生成|给出)");

    // MEDIUM · 混淆 / 编码规避（藏 payload 逃避上面各检测器）
    private static final Pattern P_OBFUSCATE = Pattern.compile(
            "atob\\s*\\(|Buffer\\.from\\s*\\([^)]*base64|fromCharCode|(\\\\x[0-9a-fA-F]{2}){6,}"
                    + "|(\\\\u00[0-9a-fA-F]{2}){6,}|(%[0-9a-fA-F]{2}){8,}",
            Pattern.CASE_INSENSITIVE);
    /** 独立的长 base64 团块（>180 连续 base64 字符），常用于内嵌可执行载荷。 */
    private static final Pattern P_B64_BLOB = Pattern.compile("[A-Za-z0-9+/]{180,}={0,2}");

    private static final Pattern P_URL = Pattern.compile("https?://([a-zA-Z0-9.-]+)", Pattern.CASE_INSENSITIVE);

    /** 扫描单个技能定义，返回带权发现列表。 */
    public List<Finding> scan(Skill s) {
        List<Finding> out = new ArrayList<>();
        String name = nz(s.getName());
        String desc = nz(s.getDescription());
        String sop = nz(s.getSopContent());
        String code = nz(s.getCode());
        String action = nz(s.getActionScript());
        String prose = name + "\n" + desc + "\n" + sop;                 // 自然语言面（注入/绕过/虚构）
        String script = code + "\n" + action;                          // 脚本面（执行/供应链/混淆）
        String all = prose + "\n" + script;

        BiConsumer<Pattern, Finding4> run = (p, f) ->
                findAll(p, f.text, ev -> out.add(new Finding(f.sev, f.type, f.detail, ev, f.weight)));

        // ── HIGH ──
        run.accept(P_INJECTION, new Finding4(prose, "HIGH", "提示注入/越权指令", 40,
                "含改写系统指令/越权扮演的注入文本——可诱导分身脱离安全边界"));
        run.accept(P_BYPASS, new Finding4(all, "HIGH", "确认绕过", 40,
                "试图绕过人工确认/审批——违反“写操作须人工确认+签名”红线"));
        run.accept(P_EXFIL, new Finding4(all, "HIGH", "凭证/数据外传", 45,
                "含凭证或敏感数据外传意图——违反“凭证只在本地”红线"));
        run.accept(P_CODE_EXEC, new Finding4(script, "HIGH", "脚本执行/沙箱逃逸", 40,
                "脚本含代码执行/环境访问原语——语义技能不应含任何代码执行面"));
        run.accept(P_SUPPLY, new Finding4(script, "HIGH", "供应链/命令投递", 40,
                "含下载即执行或包管理器安装指令——存在供应链投毒风险"));

        // ── MEDIUM ──
        run.accept(P_FABRICATE, new Finding4(all, "MEDIUM", "虚构数据倾向", 20,
                "SOP/脚本含虚构数据指示——违反真实性红线，建议人工复核"));
        run.accept(P_OBFUSCATE, new Finding4(all, "MEDIUM", "混淆/编码规避", 22,
                "含编码/混淆载荷——可能藏匿逃避静态检测的 payload"));
        findAll(P_B64_BLOB, script, ev -> out.add(new Finding("MEDIUM", "内嵌二进制载荷",
                "脚本内含超长 base64 团块（" + ev.length() + " 字符）——疑似内嵌可执行载荷", ev.substring(0, Math.min(40, ev.length())) + "…", 22)));

        // 外部域名外发面（去重，可信主机放行）
        Set<String> hosts = new LinkedHashSet<>();
        Matcher hm = P_URL.matcher(all);
        while (hm.find()) { String h = hm.group(1).toLowerCase(); if (!TRUSTED_HOSTS.contains(h)) hosts.add(h); }
        if (!hosts.isEmpty()) out.add(new Finding("MEDIUM", "外部域名外发面",
                "回放时可能向外部域名提交数据，确认其为可信业务系统", String.join("、", hosts), 15));

        // 未知 DSL 指令
        for (String line : code.split("\n")) {
            String tl = line.trim();
            if (tl.isEmpty() || tl.startsWith("#") || tl.startsWith("//")) continue;
            String op = tl.split("[\\s(]", 2)[0].toLowerCase();
            if (!op.isEmpty() && op.matches("[a-z]{2,}") && !DSL_OPS.contains(op))
                out.add(new Finding("MEDIUM", "未知 DSL 指令", "脚本含未知操作码「" + op + "」", snippet(tl), 12));
        }

        // 资源滥用
        if (sop.length() > MAX_FIELD_LEN || code.length() > MAX_FIELD_LEN || action.length() > MAX_FIELD_LEN)
            out.add(new Finding("MEDIUM", "超大字段", "SOP/脚本超过 200KB，存在资源滥用风险", "", 12));

        // ── LOW ──
        if (s.getTriggerKeywords() != null) {
            for (String kw : s.getTriggerKeywords())
                if (kw != null && kw.trim().length() == 1)
                    out.add(new Finding("LOW", "过泛触发词", "触发词过于宽泛，可能劫持无关对话", kw, 5));
            if (s.getTriggerKeywords().size() > 30)
                out.add(new Finding("LOW", "触发词过多", "触发词达 " + s.getTriggerKeywords().size() + " 个，命中面过宽", "", 5));
        }
        if (s.getTargetSystemId() != null && !s.getTargetSystemId().isBlank())
            out.add(new Finding("LOW", "外源系统绑定", "包内携带 targetSystemId（外部环境的系统 id），导入时已自动清空，需重新绑定本地业务系统", s.getTargetSystemId(), 3));

        return out;
    }

    /** 扫描技能包的整目录脚本文件（SKILL.md 已随 Skill 扫过，此处只扫其余脚本）。 */
    public List<Finding> scanBundle(Map<String, String> files) {
        List<Finding> out = new ArrayList<>();
        for (Map.Entry<String, String> e : files.entrySet()) {
            String f = e.getKey();
            if (f.equalsIgnoreCase("SKILL.md")) continue;
            String txt = nz(e.getValue());
            findAll(P_CODE_EXEC, txt, ev -> out.add(new Finding("HIGH", "脚本执行/沙箱逃逸",
                    "脚本 " + f + " 含代码执行/环境访问原语——iML 沙箱不执行宿主命令", ev, 40)));
            findAll(P_SUPPLY, txt, ev -> out.add(new Finding("HIGH", "供应链/命令投递",
                    "脚本 " + f + " 含下载即执行/包管理器安装", ev, 40)));
            findAll(P_EXFIL, txt, ev -> out.add(new Finding("HIGH", "凭证/数据外传",
                    "脚本 " + f + " 含敏感数据外传", ev, 45)));
            findAll(P_INJECTION, txt, ev -> out.add(new Finding("HIGH", "提示注入/越权指令",
                    "脚本 " + f + " 含注入式文本", ev, 40)));
            findAll(P_OBFUSCATE, txt, ev -> out.add(new Finding("MEDIUM", "混淆/编码规避",
                    "脚本 " + f + " 含编码/混淆载荷", ev, 22)));
        }
        return out;
    }

    /** 聚合定级：任一 HIGH → HIGH；否则按加权分给出等级。附 0–100 riskScore。 */
    public Map<String, Object> report(List<Finding> findings) {
        int score = 0;
        boolean high = false, medium = false, low = false;
        for (Finding f : findings) {
            score += f.weight();
            switch (f.severity()) {
                case "HIGH" -> high = true;
                case "MEDIUM" -> medium = true;
                default -> low = true;
            }
        }
        score = Math.min(100, score);
        String risk;
        if (high) risk = "HIGH";
        else if (medium || score >= 40) risk = "MEDIUM";
        else if (low) risk = "LOW";
        else risk = "SAFE";

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("risk", risk);
        m.put("riskScore", score);
        m.put("blocked", high);
        m.put("findings", findings.stream().map(f -> {
            Map<String, Object> fm = new LinkedHashMap<>();
            fm.put("severity", f.severity());
            fm.put("type", f.type());
            fm.put("detail", f.detail());
            fm.put("evidence", f.evidence());
            return fm;
        }).toList());
        m.put("engine", "iml-java-scanner v2 · 多检测器加权（威胁模型参考 Tencent AI-Infra-Guard）");
        return m;
    }

    // ── helpers ──
    private record Finding4(String text, String sev, String type, int weight, String detail) {}

    private static String nz(String s) { return s == null ? "" : s; }

    private static void findAll(Pattern p, String text, java.util.function.Consumer<String> onHit) {
        Matcher m = p.matcher(text);
        Set<String> seen = new LinkedHashSet<>();
        while (m.find()) { if (seen.add(m.group().toLowerCase())) onHit.accept(m.group()); }
    }

    private static String snippet(String s) {
        String t = s.replaceAll("\\s+", " ").trim();
        return t.length() > 60 ? t.substring(0, 60) + "…" : t;
    }
}
