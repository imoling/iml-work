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
 * <p>思路是 <b>实体归集 → 多维检测器并行 → 证据加权 → 风险定级</b>，而非单遍正则匹配。
 * 检测维度覆盖提示注入 / 工具投毒 / 数据外传 / 越权绕过 / 供应链，
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

    // ── 脚本面检测器：按**沙箱威胁模型**定档，不是按「含什么词」──────────────
    // 旧版把 child_process/process.env/import( 一律判 HIGH 硬拦，依据是「语义技能不应含代码执行面」。
    // 那是 DSL 技能时代的假设：现在平台自己的生成类技能就在公司 Docker 沙箱里跑 Python
    //（依赖白名单 + /out 产物围栏），第三方包脚本同样不碰宿主。真实工单：Impeccable 技能包
    // 的 reference/*.md 文档代码示例被判 HIGH 拦死（2026-08-12）。故拆成三档：

    // HIGH · 下载即执行（真正的供应链投递面——拉来的东西直接进解释器）
    private static final Pattern P_DOWNLOAD_EXEC = Pattern.compile(
            "(curl|wget)\\b.{0,80}\\|\\s*(sh|bash|zsh)|bash\\s+-c|powershell|Invoke-Expression|\\biex\\b",
            Pattern.CASE_INSENSITIVE);

    // MEDIUM · 包管理器安装（沙箱按依赖白名单放行，越权包装不上；宿主不可达）
    private static final Pattern P_PKG_INSTALL = Pattern.compile(
            "(npm|pnpm|yarn|pip|pip3|brew|apt|gem)\\s+(install|add|i)\\s",
            Pattern.CASE_INSENSITIVE);

    // MEDIUM · 沙箱受控原语（宿主视角高危、沙箱视角日常：真正的围栏是 Docker+白名单，不是这条正则）
    private static final Pattern P_SANDBOX_PRIM = Pattern.compile(
            "\\beval\\s*\\(|new\\s+Function|child_process|\\bexec(Sync)?\\s*\\(|\\bspawn(Sync)?\\s*\\("
                    + "|\\brequire\\s*\\(|\\bimport\\s*\\(|process\\.(env|exit|binding)"
                    + "|fs\\.(read|write|append|unlink|rm|mkdir)|__proto__|globalThis|XMLHttpRequest"
                    + "|os\\.system|subprocess\\.",
            Pattern.CASE_INSENSITIVE);

    // 执行器词干（单独出现按上面定档；与混淆载荷**同文件共现**时升 HIGH——解码后喂执行器是典型藏毒手法）
    private static final Pattern P_EXEC_STEM = Pattern.compile(
            "\\beval\\s*\\(|new\\s+Function|\\bexec(Sync)?\\s*\\(|os\\.system|subprocess\\.|child_process|\\bspawn",
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

    // ── 组合信号：人工复核档（体检 P2-3）──────────────────────────────────────
    // 上面每个检测器都是**黑名单正则**，假阴性面天然大：P_EXFIL 靠 SEND 词表，换成
    //「转发给/邮给/贴到/同步至」就漏；漏了就降到 MEDIUM 直接放行。
    // 组合信号不依赖具体动词：只要「有外发能力（网络 API 或非白名单外部主机）」**且**「碰密钥词干」，
    // 就判 needsReview——不阻断安装，但必须管理员显式接受风险（force）才落库。
    /** 网络外发能力（语言无关的 API 面，不是中文动词表）。 */
    private static final Pattern P_NET_API = Pattern.compile(
            "\\bfetch\\s*\\(|\\baxios\\b|XMLHttpRequest|sendBeacon|navigator\\.send"
                    + "|requests\\.(post|put|get)|urllib|http\\.client|httpx|aiohttp"
                    + "|smtplib|nodemailer|sendmail|webhook|api\\.telegram\\.org|hooks\\.slack\\.com"
                    + "|\\bcurl\\b|\\bwget\\b|WebSocket\\s*\\(",
            Pattern.CASE_INSENSITIVE);
    /** 密钥/凭证词干（复用 SECRET，但独立成 Pattern 供组合判定）。 */
    private static final Pattern P_SECRET_STEM = Pattern.compile(SECRET, Pattern.CASE_INSENSITIVE);

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
        run.accept(P_DOWNLOAD_EXEC, new Finding4(script, "HIGH", "供应链/命令投递", 40,
                "脚本含下载即执行指令——存在供应链投毒风险"));

        // ── MEDIUM · 脚本面（在公司 Docker 沙箱内运行，碰不到宿主；如实列出交用户/管理员判读）──
        run.accept(P_PKG_INSTALL, new Finding4(script, "MEDIUM", "包管理器安装", 12,
                "脚本安装依赖——沙箱按依赖白名单放行，越权包装不上"));
        run.accept(P_SANDBOX_PRIM, new Finding4(script, "MEDIUM", "沙箱受控原语", 14,
                "脚本含执行/环境访问原语——在公司 Docker 沙箱内运行碰不到宿主，请确认与技能用途一致"));
        if ((P_OBFUSCATE.matcher(script).find() || P_B64_BLOB.matcher(script).find())
                && P_EXEC_STEM.matcher(script).find()) {
            out.add(new Finding("HIGH", "混淆×执行组合",
                    "脚本同时含编码/混淆载荷与执行原语——解码后执行是典型藏毒手法", "", 40));
        }

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

        // ── REVIEW · 组合信号（不依赖动词表，专治黑名单假阴性；体检 P2-3）──
        // 「外发能力 × 密钥词干」同时出现即需人工复核：P_EXFIL 漏掉的「转发给/邮给/贴到」等表述，
        // 只要技能里既碰凭证又有外发面，就一定会落到这里。REVIEW 不阻断，但必须管理员显式接受。
        boolean hasSecret = P_SECRET_STEM.matcher(all).find();
        boolean netApi = P_NET_API.matcher(all).find();
        if (hasSecret && (netApi || !hosts.isEmpty())) {
            String how = netApi ? "网络外发 API" : "外部域名 " + String.join("、", hosts);
            out.add(new Finding("REVIEW", "外发能力×凭证词组合",
                    "同时具备外发能力与凭证/密钥相关内容——静态规则无法判定是否真会外传，须人工阅读该技能后决定",
                    how, 30));
        }

        // 未知 DSL 指令——只对 DSL 引擎（playwright）技能有意义；python-sandbox 技能的 code 是
        // Python 源码，逐行当 DSL 检会把 import/def/for 全刷成「未知操作码」噪音
        String engineType = nz(s.getType());
        if (engineType.isBlank() || "playwright".equalsIgnoreCase(engineType)) {
            for (String line : code.split("\n")) {
                String tl = line.trim();
                if (tl.isEmpty() || tl.startsWith("#") || tl.startsWith("//")) continue;
                String op = tl.split("[\\s(]", 2)[0].toLowerCase();
                if (!op.isEmpty() && op.matches("[a-z]{2,}") && !DSL_OPS.contains(op))
                    out.add(new Finding("MEDIUM", "未知 DSL 指令", "脚本含未知操作码「" + op + "」", snippet(tl), 12));
            }
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

    /**
     * 文件角色：决定用哪套检测器、什么档位。
     * · EXEC_SCRIPT（.py）——我们的引擎会把它放进公司 Docker 沙箱执行；
     * · AUX_SCRIPT（.sh/.mjs/.js/.ts…）——本平台引擎不执行的其他运行时脚本，仅随包存档；
     * · DOC（.md/.csv/.json/.txt/.yaml…）——文本资料。**文档里的代码示例不是执行面**：
     *   Impeccable 包的 reference/*.md 因含 process.env 示例被判 HIGH 拦死（2026-08-12 实锤），
     *   但模型会读文档，所以注入/绕过/外传这些**文本红线对文档照样全量扫**。
     */
    private enum FileRole { DOC, EXEC_SCRIPT, AUX_SCRIPT }

    private static FileRole roleOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".py")) return FileRole.EXEC_SCRIPT;
        if (p.endsWith(".sh") || p.endsWith(".bash") || p.endsWith(".mjs") || p.endsWith(".js")
                || p.endsWith(".cjs") || p.endsWith(".ts") || p.endsWith(".rb") || p.endsWith(".ps1"))
            return FileRole.AUX_SCRIPT;
        return FileRole.DOC;
    }

    /** 扫描技能包整目录（SKILL.md 已随 Skill 扫过，此处扫其余文件，按角色分层定档）。 */
    public List<Finding> scanBundle(Map<String, String> files) {
        List<Finding> out = new ArrayList<>();
        for (Map.Entry<String, String> e : files.entrySet()) {
            String f = e.getKey();
            if (f.equalsIgnoreCase("SKILL.md")) continue;
            String txt = nz(e.getValue());
            FileRole role = roleOf(f);

            // 文本红线：任何角色的文件都全量扫——模型会读它们，文档同样能注入/教唆
            findAll(P_INJECTION, txt, ev -> out.add(new Finding("HIGH", "提示注入/越权指令",
                    "文件 " + f + " 含注入式文本", ev, 40)));
            findAll(P_BYPASS, txt, ev -> out.add(new Finding("HIGH", "确认绕过",
                    "文件 " + f + " 试图绕过人工确认/审批", ev, 40)));
            findAll(P_EXFIL, txt, ev -> out.add(new Finding("HIGH", "凭证/数据外传",
                    "文件 " + f + " 含敏感数据外传语义", ev, 45)));
            findAll(P_OBFUSCATE, txt, ev -> out.add(new Finding("MEDIUM", "混淆/编码规避",
                    "文件 " + f + " 含编码/混淆载荷", ev, 22)));

            boolean obf = P_OBFUSCATE.matcher(txt).find() || P_B64_BLOB.matcher(txt).find();
            switch (role) {
                case DOC ->
                    // 文档引用下载即执行命令（教程里常见）：不会被引擎执行，降档提示复核即可
                    findAll(P_DOWNLOAD_EXEC, txt, ev -> out.add(new Finding("MEDIUM", "文档含下载执行示例",
                            "文档 " + f + " 引用了下载即执行命令（引擎不执行文档，提醒复核）", ev, 10)));
                case EXEC_SCRIPT -> {
                    findAll(P_DOWNLOAD_EXEC, txt, ev -> out.add(new Finding("HIGH", "供应链/命令投递",
                            "脚本 " + f + " 含下载即执行", ev, 40)));
                    findAll(P_PKG_INSTALL, txt, ev -> out.add(new Finding("MEDIUM", "包管理器安装",
                            "脚本 " + f + " 安装依赖（沙箱按白名单放行，越权包装不上）", ev, 12)));
                    findAll(P_SANDBOX_PRIM, txt, ev -> out.add(new Finding("MEDIUM", "沙箱受控原语",
                            "脚本 " + f + " 含执行/环境原语（在公司 Docker 沙箱内运行，碰不到宿主）", ev, 14)));
                    if (obf && P_EXEC_STEM.matcher(txt).find())
                        out.add(new Finding("HIGH", "混淆×执行组合",
                                "脚本 " + f + " 同时含编码载荷与执行原语——解码后执行是典型藏毒手法", "", 40));
                }
                case AUX_SCRIPT -> {
                    findAll(P_DOWNLOAD_EXEC, txt, ev -> out.add(new Finding("MEDIUM", "辅助脚本含下载执行",
                            "脚本 " + f + " 含下载即执行（本平台引擎不执行该类型文件，仅随包存档）", ev, 15)));
                    findAll(P_SANDBOX_PRIM, txt, ev -> out.add(new Finding("LOW", "辅助脚本执行原语",
                            "脚本 " + f + " 含执行/环境原语（本平台引擎不执行该类型文件，仅随包存档）", ev, 4)));
                    if (obf && P_EXEC_STEM.matcher(txt).find())
                        out.add(new Finding("REVIEW", "混淆×执行组合",
                                "辅助脚本 " + f + " 同时含编码载荷与执行原语——虽不被本平台执行，仍须人工确认包来源可信", f, 25));
                }
            }
        }
        return out;
    }

    /** 聚合定级：任一 HIGH → HIGH 阻断；任一 REVIEW → 需人工复核（不阻断但须显式接受）；否则按加权分定级。 */
    public Map<String, Object> report(List<Finding> findings) {
        int score = 0;
        boolean high = false, medium = false, low = false, review = false;
        List<String> reviewReasons = new ArrayList<>();
        for (Finding f : findings) {
            score += f.weight();
            switch (f.severity()) {
                case "HIGH" -> high = true;
                case "REVIEW" -> { review = true; reviewReasons.add(f.type() + "：" + f.evidence()); }
                case "MEDIUM" -> medium = true;
                default -> low = true;
            }
        }
        score = Math.min(100, score);
        String risk;
        if (high) risk = "HIGH";
        else if (review) risk = "REVIEW";
        else if (medium || score >= 40) risk = "MEDIUM";
        else if (low) risk = "LOW";
        else risk = "SAFE";

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("risk", risk);
        m.put("riskScore", score);
        m.put("blocked", high);
        // 需人工复核（体检 P2-3）：静态规则拿不准的组合信号，交人读——不放行也不武断阻断
        m.put("reviewRequired", review && !high);
        m.put("reviewReasons", reviewReasons);
        m.put("findings", findings.stream().map(f -> {
            Map<String, Object> fm = new LinkedHashMap<>();
            fm.put("severity", f.severity());
            fm.put("type", f.type());
            fm.put("detail", f.detail());
            fm.put("evidence", f.evidence());
            return fm;
        }).toList());
        m.put("engine", "iml-java-scanner v3 · 文件角色分层 + 沙箱威胁模型");
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
