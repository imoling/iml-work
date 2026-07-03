package com.imlwork.admin.service;

import com.imlwork.admin.model.Skill;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 技能包导入前的静态安全检查。风险分类参考 Tencent AI-Infra-Guard 对 AI 组件/MCP 的
 * 威胁模型（提示注入 / 工具投毒 / 数据外传 / 越权绕过），结合本项目安全红线
 * （写操作须人工确认+签名、凭证绝不上传、绝不虚构业务数据）落成规则：
 *  - HIGH   直接阻断安装：确认/审批绕过、凭证外传、脚本执行注入
 *  - MEDIUM 告警可继续：虚构数据倾向、外部域名外发面、未知 DSL 指令、超大字段
 *  - LOW    提示信息：过泛触发词（劫持面）、外源系统绑定（导入时清空）
 * 规则引擎为本地静态扫描；如需深度扫描可外接 AI-Infra-Guard 服务替换本实现。
 */
@Service
public class SkillSecurityService {

    public record Finding(String severity, String type, String detail) {}

    /** 已知的 Skill DSL 操作码；包外脚本出现未知指令按可疑处理。 */
    private static final Set<String> DSL_OPS = Set.of(
            "open", "click", "fill", "select", "searchselect", "pickoption", "hover",
            "wait", "press", "read", "extract", "goto", "type", "submit", "check", "scroll");

    // HIGH：确认/审批绕过、凭证外传（对齐红线：写操作须人工确认+签名、凭证只在本地）
    private static final Pattern P_BYPASS = Pattern.compile(
            "跳过(人工)?(确认|审批|签名)|绕过(人工)?(确认|审批|签名|权限)|无需(用户|人工)确认|自动(通过|同意)审批"
                    + "|忽略(之前|上述|以上|系统|安全).{0,8}(指令|规则|提示|限制)|ignore\\s+(previous|above|all)\\s+(instructions|rules)");
    private static final Pattern P_EXFIL = Pattern.compile(
            "(发送|上传|外发|提交|同步|发到|传到|回传).{0,20}(密码|凭证|登录态|cookie|token|密钥|api\\s*key)"
                    + "|(密码|凭证|登录态|cookie|token|密钥|api\\s*key).{0,20}(发送|上传|外发|提交|同步|发到|传到|回传|外传)"
                    + "|(窃取|收集|盗取).{0,10}(账号|密码|凭证|登录态)|exfiltrat|steal.{0,12}(credential|password|token|cookie)",
            Pattern.CASE_INSENSITIVE);
    // HIGH：DSL 里出现脚本执行/环境访问原语（语义技能不应含任何代码执行面）
    private static final Pattern P_CODE_EXEC = Pattern.compile(
            "\\beval\\s*\\(|child_process|\\bexec\\s*\\(|\\bspawn\\s*\\(|require\\s*\\(|import\\s*\\("
                    + "|process\\.env|fs\\.(read|write|unlink|rm)|XMLHttpRequest|\\bfetch\\s*\\(|new\\s+Function",
            Pattern.CASE_INSENSITIVE);

    // MEDIUM：虚构数据倾向（违反真实性红线）
    private static final Pattern P_FABRICATE = Pattern.compile("(编造|虚构|捏造).{0,8}(数据|结果|条目|记录)|即使没有.{0,6}也要(给出|返回)");
    private static final Pattern P_URL = Pattern.compile("https?://([a-zA-Z0-9.-]+)");

    private static final Set<String> TRUSTED_HOSTS = Set.of("localhost", "127.0.0.1", "github.com", "raw.githubusercontent.com");
    private static final int MAX_FIELD_LEN = 200_000;

    /** 扫描单个技能定义，返回按严重度排序的发现列表。 */
    public List<Finding> scan(Skill s) {
        List<Finding> out = new ArrayList<>();
        String sop = nz(s.getSopContent());
        String code = nz(s.getCode());
        String action = nz(s.getActionScript());
        String all = sop + "\n" + code + "\n" + action + "\n" + nz(s.getDescription());

        // ── HIGH ──
        findAll(P_BYPASS, all, m -> out.add(new Finding("HIGH", "确认绕过/提示注入",
                "检测到绕过人工确认或注入式指令：「" + snippet(m) + "」——违反“写操作须人工确认+签名”红线")));
        findAll(P_EXFIL, all, m -> out.add(new Finding("HIGH", "凭证/数据外传",
                "检测到凭证或敏感数据外传意图：「" + snippet(m) + "」——违反“凭证只在本地”红线")));
        findAll(P_CODE_EXEC, code + "\n" + action, m -> out.add(new Finding("HIGH", "脚本执行注入",
                "技能脚本包含代码执行原语：「" + snippet(m) + "」——语义技能不应含任何代码执行面")));

        // ── MEDIUM ──
        findAll(P_FABRICATE, all, m -> out.add(new Finding("MEDIUM", "虚构数据倾向",
                "SOP/脚本含虚构数据指示：「" + snippet(m) + "」——违反真实性红线，建议人工复核")));
        Set<String> hosts = new LinkedHashSet<>();
        Matcher hm = P_URL.matcher(code + "\n" + action + "\n" + sop);
        while (hm.find()) {
            String h = hm.group(1).toLowerCase();
            if (!TRUSTED_HOSTS.contains(h)) hosts.add(h);
        }
        if (!hosts.isEmpty()) out.add(new Finding("MEDIUM", "外部域名外发面",
                "技能内含外部地址：" + String.join("、", hosts) + " ——回放时可能向该域名提交数据，确认其为可信业务系统"));
        for (String line : code.split("\n")) {
            String tl = line.trim();
            if (tl.isEmpty() || tl.startsWith("#") || tl.startsWith("//")) continue;
            String op = tl.split("[\\s(]", 2)[0].toLowerCase();
            if (!op.isEmpty() && op.matches("[a-z]+") && !DSL_OPS.contains(op)) {
                out.add(new Finding("MEDIUM", "未知 DSL 指令", "脚本含未知操作码「" + op + "」：" + snippet(tl)));
            }
        }
        if (sop.length() > MAX_FIELD_LEN || code.length() > MAX_FIELD_LEN || action.length() > MAX_FIELD_LEN) {
            out.add(new Finding("MEDIUM", "超大字段", "SOP/脚本超过 200KB，存在资源滥用风险"));
        }

        // ── LOW ──
        if (s.getTriggerKeywords() != null) {
            for (String kw : s.getTriggerKeywords()) {
                if (kw != null && kw.trim().length() == 1) {
                    out.add(new Finding("LOW", "过泛触发词", "触发词「" + kw + "」过于宽泛，可能劫持无关对话"));
                }
            }
        }
        if (s.getTargetSystemId() != null && !s.getTargetSystemId().isBlank()) {
            out.add(new Finding("LOW", "外源系统绑定", "包内携带 targetSystemId（外部环境的系统 id），导入时已自动清空，需重新绑定本地业务系统"));
        }
        return out;
    }

    /** 汇总风险等级：任一 HIGH → HIGH；否则 MEDIUM/LOW/SAFE。 */
    public Map<String, Object> report(List<Finding> findings) {
        String risk = "SAFE";
        for (Finding f : findings) {
            if ("HIGH".equals(f.severity())) { risk = "HIGH"; break; }
            if ("MEDIUM".equals(f.severity())) risk = "MEDIUM";
            else if ("LOW".equals(f.severity()) && "SAFE".equals(risk)) risk = "LOW";
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("risk", risk);
        m.put("findings", findings.stream().map(f -> Map.of(
                "severity", f.severity(), "type", f.type(), "detail", f.detail())).toList());
        m.put("engine", "iml-static-rules (风险模型参考 Tencent AI-Infra-Guard)");
        return m;
    }

    private static String nz(String s) { return s == null ? "" : s; }

    private static void findAll(Pattern p, String text, java.util.function.Consumer<String> onHit) {
        Matcher m = p.matcher(text);
        Set<String> seen = new LinkedHashSet<>();
        while (m.find()) { if (seen.add(m.group())) onHit.accept(m.group()); }
    }

    private static String snippet(String s) {
        String t = s.replaceAll("\\s+", " ").trim();
        return t.length() > 60 ? t.substring(0, 60) + "…" : t;
    }
}
