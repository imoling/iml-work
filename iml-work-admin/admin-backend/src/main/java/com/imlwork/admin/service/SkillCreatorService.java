package com.imlwork.admin.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.imlwork.admin.model.Skill;
import com.imlwork.admin.repository.SkillRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 技能智能创造器：一句话指令 → （必要时）追问选项卡 → 技能草稿（SKILL.md + 脚本）→ 校验 → 落库。
 * 管理端技能中心 / FDE 工作台 / 客户端三方共用同一引擎（单一来源，不各写一套 LLM 编排）。
 *
 * 方法论以 Anthropic 官方 skill-creator 为底座：技能库中存在名为 skill-creator 的技能包时，
 * 运行时读取其 SKILL.md 作为系统方法论注入（语料放数据不放代码）；缺席时用内置精简版兜底。
 *
 * 无状态会话：追问的答案由前端随下一次请求原样带回（answers），服务端不建会话表。
 */
@Service
public class SkillCreatorService {

    private final ModelProxyService modelProxy;
    private final SkillRepository skillRepository;
    private final SkillService skillService;
    private final SkillSecurityService security;
    private final ObjectMapper mapper;

    public SkillCreatorService(ModelProxyService modelProxy, SkillRepository skillRepository,
                               SkillService skillService, SkillSecurityService security, ObjectMapper mapper) {
        this.modelProxy = modelProxy;
        this.skillRepository = skillRepository;
        this.skillService = skillService;
        this.security = security;
        this.mapper = mapper;
    }

    // ── 草稿生成（含追问）─────────────────────────────────────────────────────

    /**
     * 生成草稿或追问。answers 为空=首轮（允许追问，至多 3 题、每题 2-4 个选项）；
     * answers 非空=续轮（禁止再追问，必须产出草稿）——追问最多一轮，避免无限盘问。
     */
    public Map<String, Object> draft(String instruction, Map<String, String> answers) {
        String inst = instruction == null ? "" : instruction.trim();
        if (inst.isBlank()) throw new IllegalArgumentException("请先描述要创建的技能（做什么、格式/规则是什么）");
        Map<String, String> ans = answers == null ? Map.of() : answers;
        boolean followUp = !ans.isEmpty();

        StringBuilder p = new StringBuilder();
        p.append("你是企业「工作分身」平台的技能设计师。参照下述方法论，把用户的一句话指令转化为可落库执行的技能。\n\n");
        p.append("── 方法论（节选自 skill-creator）──\n").append(methodology()).append("\n──────\n\n");
        p.append("平台约束：\n")
         .append("· 执行引擎三选一：knowledge（纯规范/指南，注入分身上下文照做）、python-sandbox（Python 脚本在公司 Docker 沙箱执行，")
         .append("可用 python-docx/openpyxl/python-pptx/reportlab/pandas 等，适合文档生成与格式化）、playwright（业务系统网页自动化——")
         .append("凭空写不可靠，此类需求建议提示用户改用 FDE 录制，不要选它）。\n")
         .append("· triggerKeywords：5-8 个中文口语触发词，覆盖用户常见说法。\n")
         .append("· description 要\"pushy\"：写清做什么 + 何时触发（含用户可能的各种说法），这是触发的主要依据。\n")
         .append("· sopContent 即 SKILL.md 正文：Markdown、祈使句、＜300 行；含操作步骤与输出/反馈要求。\n")
         .append("· scripts 可选：path 形如 scripts/xxx.py；脚本要自包含、带用法注释；禁止网络外传/凭证收集/系统破坏（无惊喜原则），")
         .append("此类指令直接拒绝并在 riskNotes 说明。\n")
         .append("· 写操作类（提交/审批业务系统）由平台强制人工确认，SOP 中不必自行设计确认环节。\n\n");
        p.append("用户指令：").append(inst).append("\n");
        if (followUp) {
            p.append("\n用户对追问的回答：\n");
            for (Map.Entry<String, String> e : ans.entrySet()) {
                p.append("· ").append(e.getKey()).append("：").append(e.getValue()).append("\n");
            }
            p.append("\n信息已足够，**不得再追问**，直接产出草稿。\n");
        } else {
            p.append("\n若关键信息缺失（如纸型/输出格式/触发场景边界），先追问：最多 3 题，每题给 2-4 个候选选项；")
             .append("信息已足够则直接产出草稿，不要为了追问而追问。\n");
        }
        p.append("\n只输出严格 JSON（无解释、无代码块标记），二选一：\n")
         .append("{\"questions\":[{\"id\":\"英文短id\",\"question\":\"…？\",\"options\":[\"…\",\"…\"],\"allowCustom\":true}]}\n")
         .append("或 {\"draft\":{\"name\":\"…\",\"description\":\"…\",\"triggerKeywords\":[\"…\"],\"type\":\"knowledge|python-sandbox\",")
         .append("\"category\":\"…\",\"sopContent\":\"# …\",\"scripts\":[{\"path\":\"scripts/x.py\",\"content\":\"…\"}],\"riskNotes\":\"…\"}}");

        Map<String, Object> parsed = parseLooseJson(extractContent(chat(p.toString())));
        Object qs = parsed.get("questions");
        if (!followUp && qs instanceof List<?> ql && !ql.isEmpty()) {
            List<Map<String, Object>> shaped = shapeQuestions(ql);
            if (!shaped.isEmpty()) return Map.of("questions", shaped);
        }
        Object draft = parsed.get("draft");
        if (!(draft instanceof Map)) {
            // 输出跑偏/截断各有偶发（模型方差），盲报错太脆——带纠偏提示重试一次再判失败
            String retry = p + "\n\n（上次输出无法解析为合法 JSON。重新输出：只输出 JSON 本体；"
                    + "脚本内容里的换行必须转义为 \\n；脚本保持精炼（≤150 行）；不要输出任何解释文字。）";
            parsed = parseLooseJson(extractContent(chat(retry)));
            draft = parsed.get("draft");
        }
        if (!(draft instanceof Map)) {
            throw new IllegalArgumentException("模型未能产出技能草稿，请补充指令细节后重试");
        }
        @SuppressWarnings("unchecked") Map<String, Object> d = (Map<String, Object>) draft;
        if (str(d.get("name")).isBlank() || str(d.get("sopContent")).isBlank()) {
            throw new IllegalArgumentException("草稿缺少名称或 SOP 内容，请补充指令细节后重试");
        }
        return Map.of("draft", d);
    }

    /** 追问题目形状裁剪：≤3 题、每题 2-4 个选项、缺 id 补位。 */
    private List<Map<String, Object>> shapeQuestions(List<?> raw) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object o : raw) {
            if (!(o instanceof Map<?, ?> m) || out.size() >= 3) continue;
            String q = str(m.get("question"));
            if (q.isBlank()) continue;
            List<String> opts = new ArrayList<>();
            if (m.get("options") instanceof List<?> ol) for (Object op : ol) { if (opts.size() < 4 && op != null && !String.valueOf(op).isBlank()) opts.add(String.valueOf(op)); }
            if (opts.size() < 2) continue;   // 没有像样的选项就不算追问题
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", str(m.get("id")).isBlank() ? "q" + (out.size() + 1) : str(m.get("id")));
            item.put("question", q);
            item.put("options", opts);
            item.put("allowCustom", !(m.get("allowCustom") instanceof Boolean b) || b);
            out.add(item);
        }
        return out;
    }

    // ── 校验 ─────────────────────────────────────────────────────────────────

    /** 草稿静态校验 + 安全扫描：返回逐项报告（像验收表），HIGH 红线即 pass=false。 */
    public Map<String, Object> validate(Map<String, Object> draft) {
        List<Map<String, Object>> items = new ArrayList<>();
        String name = str(draft.get("name")), sop = str(draft.get("sopContent"));
        List<String> kws = strList(draft.get("triggerKeywords"));
        items.add(row("技能名称", !name.isBlank() && name.length() <= 40, name.isBlank() ? "缺失" : name));
        items.add(row("触发词", kws.size() >= 1 && kws.size() <= 10, kws.isEmpty() ? "缺失（客户端将永远匹配不到）" : String.join("、", kws)));
        items.add(row("SOP 内容", !sop.isBlank(), sop.isBlank() ? "缺失" : sop.lines().count() + " 行"));
        String type = str(draft.get("type"));
        items.add(row("执行引擎", type.equals("knowledge") || type.equals("python-sandbox"), type.isBlank() ? "缺失" : type));

        Map<String, String> bundle = bundleOf(draft);
        boolean pathOk = bundle.keySet().stream().noneMatch(k -> k.contains("..") || k.startsWith("/"));
        items.add(row("脚本路径", pathOk, pathOk ? bundle.size() + " 个文件" : "含越权路径（../ 或绝对路径）"));

        Skill probe = fromDraft(draft, null);
        List<SkillSecurityService.Finding> findings = new ArrayList<>(security.scan(probe));
        findings.addAll(security.scanBundle(bundle));
        Map<String, Object> rep = security.report(findings);
        boolean high = "HIGH".equals(rep.get("risk"));
        items.add(row("安全扫描", !high, String.valueOf(rep.get("risk"))));

        boolean pass = items.stream().allMatch(i -> Boolean.TRUE.equals(i.get("ok")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", items);
        out.put("security", rep);
        out.put("pass", pass);
        return out;
    }

    // ── 落库 ─────────────────────────────────────────────────────────────────

    /** 员工自建：私有技能立即可用（ownerUserId 归属，经 /skills/mine 下发本人客户端，不进岗位技能池）。 */
    @Transactional
    public Skill saveAsPrivate(Map<String, Object> draft, String ownerUserId, String ownerName) {
        Skill s = fromDraft(draft, "skill-usr-" + UUID.randomUUID().toString().substring(0, 8));
        s.setOwnerUserId(ownerUserId);
        s.setSource("user-created:" + ownerName);
        s.setStatus("PUBLISHED");
        s.setAllowedRoles(new ArrayList<>());
        return skillService.create(s);   // 复用统一入口：blockIfHighRisk 安全闸在此生效
    }

    /**
     * 员工实操录制自建：私有 playwright 回放技能立即可用（ownerUserId 归属，经 /skills/mine 下发本人客户端）。
     * 与 {@link #saveAsPrivate} 的区别：录制技能是确定性回放脚本（actionScript + 绑定业务系统），不是
     * 创造器的 generate 型 bundle，故单独构造、保留 actionScript/targetSystemId，不套 fromDraft 的 generate 语义。
     */
    @Transactional
    public Skill saveRecordedAsPrivate(Map<String, Object> body, String ownerUserId, String ownerName) {
        Skill s = new Skill();
        s.setId("skill-rec-" + UUID.randomUUID().toString().substring(0, 8));
        s.setName(str(body.get("name")));
        s.setType("playwright");
        s.setCategory("录制技能");
        // 意图描述（客户端 AI 转译产出，供路由语义匹配）；缺省回退通用文案。
        String desc = str(body.get("description"));
        s.setDescription(desc.isBlank() ? "由浏览器实操录制生成的可回放技能。" : desc);
        s.setTriggerKeywords(strList(body.get("triggerKeywords")));
        s.setTargetSystemId(str(body.get("targetSystemId")));
        s.setActionScript(str(body.get("actionScript")));
        // 读/写判定（写入类执行前强制人工确认+签名）：客户端语义层显式传入，缺省留空由执行侧按脚本推断。
        String kind = str(body.get("skillKind"));
        if (!kind.isBlank()) s.setSkillKind(kind);
        // 语义 SOP（browse 执行的可控计划）：客户端生成则采用，缺省回退通用说明。
        String sop = str(body.get("sopContent"));
        s.setSopContent(sop.isBlank() ? "本技能通过实操录制生成，执行时按确认参数由分身在真实系统中按语义完成。" : sop);
        s.setSource("user-recorded:" + ownerName);
        s.setOwnerUserId(ownerUserId);
        s.setStatus("PUBLISHED");
        s.setAllowedRoles(new ArrayList<>());
        return skillService.create(s);   // 复用统一入口：blockIfHighRisk 安全闸在此生效
    }

    /** 草稿 → Skill（bundle 与导入包同构：SKILL.md + scripts/*，客户端执行路径一致）。 */
    private Skill fromDraft(Map<String, Object> draft, String id) {
        Skill s = new Skill();
        if (id != null) s.setId(id);
        s.setName(str(draft.get("name")));
        s.setDescription(str(draft.get("description")));
        s.setTriggerKeywords(strList(draft.get("triggerKeywords")));
        Map<String, String> bundle = bundleOf(draft);
        String type = str(draft.get("type"));
        s.setType(type.isBlank() ? (bundle.keySet().stream().anyMatch(k -> k.endsWith(".py")) ? "python-sandbox" : "knowledge") : type);
        s.setCategory(str(draft.get("category")));
        s.setSopContent(str(draft.get("sopContent")));
        s.setSkillKind("generate");
        if (!bundle.isEmpty()) {
            bundle.put("SKILL.md", "---\nname: " + s.getName() + "\ndescription: " + s.getDescription() + "\n---\n\n" + s.getSopContent());
            try { s.setBundle(mapper.writeValueAsString(bundle)); } catch (Exception e) { throw new IllegalArgumentException("脚本目录序列化失败"); }
        }
        s.setUpdatedAt(LocalDateTime.now());
        return s;
    }

    /** draft.scripts → {path: content}（不含 SKILL.md，由 fromDraft 渲染补入）。 */
    private Map<String, String> bundleOf(Map<String, Object> draft) {
        Map<String, String> files = new LinkedHashMap<>();
        if (draft.get("scripts") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m) {
                    String path = str(m.get("path")), content = str(m.get("content"));
                    if (!path.isBlank() && !content.isBlank()) files.put(path, content);
                }
            }
        }
        return files;
    }

    // ── 方法论语料 ────────────────────────────────────────────────────────────

    /** 优先取技能库里的 skill-creator（Anthropic 官方包）SKILL.md；缺席用内置精简版。 */
    private String methodology() {
        try {
            for (Skill s : skillRepository.findByNameIgnoreCase("skill-creator")) {
                if (s.getBundle() == null || s.getBundle().isBlank()) continue;
                Map<String, String> files = mapper.readValue(s.getBundle(), new TypeReference<Map<String, String>>() {});
                for (Map.Entry<String, String> e : files.entrySet()) {
                    if (e.getKey().equalsIgnoreCase("SKILL.md") && e.getValue() != null && !e.getValue().isBlank()) {
                        String md = e.getValue();
                        return md.length() > 8000 ? md.substring(0, 8000) : md;   // 控制提示词体积
                    }
                }
            }
        } catch (Exception ignored) { /* 语料缺席 → 内置兜底 */ }
        return BUILTIN_METHODOLOGY;
    }

    /** 内置精简方法论（源自 anthropics/skills 的 skill-creator，中文摘要）。 */
    private static final String BUILTIN_METHODOLOGY = """
            1. 捕获意图：先弄清 ①技能让分身做什么 ②何时触发（用户会怎么说）③期望的输出格式。对话里已有的信息直接用，缺口才追问。
            2. 追问原则：只问关键缺口（边界情况、输入/输出格式、成功标准、依赖），带候选选项降低用户负担；能推断就不问。
            3. SKILL.md 解剖：frontmatter（name/description）+ Markdown 指令正文；可选 scripts/（确定性/重复任务用脚本）、references/（按需加载的文档）。
            4. 渐进披露：description 常驻上下文（约 100 词内），正文触发时载入（理想＜500 行），脚本按需执行不占上下文。
            5. description 决定触发：写明做什么 + 具体触发语境，宁可"积极"一点，覆盖用户各种说法。
            6. 无惊喜原则：技能内容与描述一致，绝不含恶意代码、数据外传、凭证收集；此类要求直接拒绝。
            7. 写作风格：祈使句、具体步骤、明确输出格式；避免空泛套话。""";

    // ── LLM 小工具（与 SkillService 同构的最小实现）──────────────────────────

    private Object chat(String prompt) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("model", "corp-default");
        payload.put("iml_long_running", true);   // 产脚本属于短输入长输出，声明长任务防网关掐断
        // max_tokens 不在此写死：网关按「模型通道」配置的最大输出 tokens 注入（管理端可配）
        payload.put("messages", List.of(Map.of("role", "user", "content", prompt)));
        ResponseEntity<?> resp = modelProxy.chat(payload);
        return resp.getBody();
    }

    @SuppressWarnings("unchecked")
    private String extractContent(Object respBody) {
        try {
            Map<String, Object> m = respBody instanceof Map ? (Map<String, Object>) respBody : mapper.readValue(String.valueOf(respBody), Map.class);
            List<?> choices = (List<?>) m.get("choices");
            if (choices == null || choices.isEmpty()) return "";
            Map<?, ?> msg = (Map<?, ?>) ((Map<?, ?>) choices.get(0)).get("message");
            return msg == null ? "" : String.valueOf(msg.get("content"));
        } catch (Exception e) { return ""; }
    }

    // 宽容解析器：草稿里带整段 Python 脚本时，模型常在 JSON 字符串里直接输出裸换行/制表符
    //（严格 JSON 非法）——不开 ALLOW_UNESCAPED_CONTROL_CHARS 必解析失败，整条创造链路白跑。
    private static final ObjectMapper LENIENT = com.fasterxml.jackson.databind.json.JsonMapper.builder()
            .enable(com.fasterxml.jackson.core.json.JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS)
            .enable(com.fasterxml.jackson.core.json.JsonReadFeature.ALLOW_SINGLE_QUOTES)
            .build();

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseLooseJson(String content) {
        if (content == null) return Map.of();
        String s = content.replaceAll("```json", "").replaceAll("```", "").trim();
        int a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a >= 0 && b > a) s = s.substring(a, b + 1);
        try { return LENIENT.readValue(s, Map.class); } catch (Exception e) {
            // 留痕供排障：截断/畸形输出没有日志就只能盲猜
            org.slf4j.LoggerFactory.getLogger(SkillCreatorService.class)
                    .warn("[skill-creator] 模型输出解析失败({}): 长度={} 头200字={}", e.getMessage(),
                            s.length(), s.substring(0, Math.min(200, s.length())));
            return Map.of();
        }
    }

    private static String str(Object o) { return o == null ? "" : String.valueOf(o).trim(); }

    private static List<String> strList(Object o) {
        List<String> out = new ArrayList<>();
        if (o instanceof List<?> l) for (Object x : l) { String v = str(x); if (!v.isBlank()) out.add(v); }
        return out;
    }

    private static Map<String, Object> row(String item, boolean ok, String detail) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("item", item);
        m.put("ok", ok);
        m.put("detail", detail);
        return m;
    }
}
