package com.imlwork.admin.service;

import com.imlwork.admin.model.Skill;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 技能相关的模型调用（叶子服务，从 SkillService 抽出——体检 B4 结构债）：
 * 触发词/SOP 生成、录制转 SOP、松散 JSON 解析。
 *
 * 为什么单独成类：技能包安装链路（SkillPackageService）与技能生命周期（SkillService）**都要**
 * 派生触发词；若把它留在 SkillService，包服务就得反向依赖 SkillService → 成环。
 * 这里是叶子（只依赖 ModelProxyService），两边都注入它，依赖单向。
 */
@Service
public class SkillLlmHelper {

    private final ModelProxyService modelProxy;
    private final ObjectMapper mapper = new ObjectMapper();

    public SkillLlmHelper(ModelProxyService modelProxy) {
        this.modelProxy = modelProxy;
    }

    /** 模型辅助生成触发关键词 + SOP（含离线模板回退）。 */
    public Map<String, Object> generate(String name, String desc, String type, String category) {
        String nm = name == null ? "" : name.trim();
        String ds = desc == null ? "" : desc.trim();
        if (nm.isBlank() && ds.isBlank()) throw new IllegalArgumentException("请先填写技能名称或描述");
        String prompt = "你是企业自动化技能设计助手。请根据技能信息生成两部分内容：\n"
                + "1) 触发关键词 triggerKeywords：5-8 个，简短、贴近用户口语、覆盖常见说法（中文为主，可含必要英文）。\n"
                + "2) 标准作业流程 sop：用 Markdown 写，分步骤、可执行，描述该技能从开始到给出反馈的关键步骤与规则，会被注入到分身的上下文。\n"
                + "技能名称：" + nm + "\n技能描述：" + ds + "\n执行引擎：" + type + "\n业务分类：" + category + "\n"
                + "只输出严格的 JSON，不要任何解释或代码块标记：{\"triggerKeywords\":[\"...\"],\"sop\":\"# ...\"}";
        try {
            String content = extractContent(chat(prompt));
            Map<String, Object> parsed = parseLooseJson(content);
            Object kw = parsed.get("triggerKeywords");
            Object sop = parsed.get("sop");
            if (kw instanceof List<?> && sop != null) {
                return Map.of("success", true, "triggerKeywords", kw, "sop", sop.toString(), "source", "model");
            }
        } catch (Exception e) { /* 模板回退 */ }
        List<String> kws = new ArrayList<>();
        if (!nm.isBlank()) kws.add(nm);
        for (String w : (nm + " " + ds).split("[\\s，,、/]+")) if (w.length() >= 2 && kws.size() < 6 && !kws.contains(w)) kws.add(w);
        String sop = "# " + (nm.isBlank() ? "技能" : nm) + " SOP\n\n## 执行步骤\n1. 解析用户意图与所需参数。\n2. 执行核心动作（" + ds + "）。\n3. 校验结果并向用户如实反馈。\n\n## 注意事项\n- 仅基于真实结果作答，不编造数据。";
        return Map.of("success", true, "triggerKeywords", kws, "sop", sop, "source", "fallback");
    }

    public Object chat(String prompt) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("model", "corp-default");
        payload.put("messages", List.of(Map.of("role", "user", "content", prompt)));
        // 服务内直调中转 Service：网关鉴权（corp key）只对外部调用方生效，
        // 之前经 Controller 硬编码默认 key，一旦生产改了 corp-key 这里会全 401。
        ResponseEntity<?> resp = modelProxy.chat(payload);
        return resp.getBody();
    }

    @SuppressWarnings("unchecked")
    public String extractContent(Object respBody) throws Exception {
        Map<String, Object> m = respBody instanceof Map ? (Map<String, Object>) respBody : mapper.readValue(String.valueOf(respBody), Map.class);
        List<?> choices = (List<?>) m.get("choices");
        if (choices == null || choices.isEmpty()) return "";
        Map<?, ?> first = (Map<?, ?>) choices.get(0);
        Map<?, ?> msg = (Map<?, ?>) first.get("message");
        return msg == null ? "" : String.valueOf(msg.get("content"));
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> parseLooseJson(String content) {
        if (content == null) return Map.of();
        String s = content.replaceAll("```json", "").replaceAll("```", "").trim();
        int a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a >= 0 && b > a) s = s.substring(a, b + 1);
        try { return mapper.readValue(s, Map.class); } catch (Exception e) { return Map.of(); }
    }

    @SuppressWarnings("unchecked")
    public String generateSop(String name, String dsl, List<Object> fields, boolean desktop) {
        StringBuilder pf = new StringBuilder();
        for (Object fo : fields) { if (fo instanceof Map) { Map<String, Object> f = (Map<String, Object>) fo; if (pf.length() > 0) pf.append("、"); pf.append(f.get("name")).append("=").append(f.get("label")); } }
        String paramSummary = pf.length() > 0 ? pf.toString() : "无";
        String engineName = desktop ? "桌面自动化（鼠标/键盘）" : "浏览器自动化（业务系统网页）";
        String sop = "";
        try {
            String prompt = "你是企业自动化技能的 SOP（标准作业流程）撰写助手。请根据下面录制生成的操作脚本，写一份**详细、专业、可读**的中文 SOP，说明该技能"
                    + "「做什么、怎么一步步做、如何向用户反馈」。\n\n"
                    + "技能名称：" + name + "\n执行引擎：" + engineName + "\n"
                    + "需用户确认的参数（执行时弹表单收集）：" + paramSummary + "\n"
                    + "操作脚本（DSL，每行一个动作；{{x}} 是用户参数；行尾 @sel=… 是录制定位、可忽略其细节）：\n" + dsl + "\n\n"
                    + "严格按以下 Markdown 结构输出（不要代码块标记，不要逐行复制 DSL）：\n"
                    + "# " + name + " SOP\n\n## 执行步骤\n"
                    + "用业务语言逐条编号描述：把 click/fill/select/searchSelect/hover/wait 等动作翻译成"
                    + "「进入X菜单」「在X字段填入{{参数}}」「选择X」「在检索框输入并选择匹配项」「等待列表加载完成」等业务动作；"
                    + (desktop ? "" : "首步说明「打开绑定的业务系统，地址来自业务系统连接，登录会话由客户端注入，无需输入账号密码」；")
                    + "可把连续的导航点击合并成一句（如「进入 客户管理 → 拜访反馈 → 新建」）；对带 {{}} 的步骤说明该值由用户确认填写；涉及读取/列表的步骤说明要抓取并整理哪些信息。\n\n"
                    + "## 反馈要求\n用要点说明：成功/失败如何向用户汇报；结果为空时如何提示；列表过长时如何截断与提示总数；异常（如未登录/无权限/弹窗拦截）时的处理。\n\n"
                    + "正文要具体、贴合脚本，不要泛泛而谈。";
            String content = extractContent(chat(prompt));
            if (content != null && !content.isBlank()) sop = content.replaceAll("```\\w*", "").trim();
        } catch (Exception e) { /* 模板 SOP */ }
        if (sop == null || sop.isBlank()) sop = "# " + name + " SOP\n\n## 执行步骤\n本技能由实操录制转换为语义脚本，执行时先弹表单确认参数（" + paramSummary + "），再按脚本逐步操作目标系统。\n\n## 反馈要求\n- 成功后向用户汇总执行结果；\n- 若遇未登录/无权限/页面异常，如实告知并停止，不编造结果。";
        return sop;
    }

    /** 无触发词的技能补一批（模型派生，失败保底只留技能名）——安装链路与生命周期共用。 */
    public void ensureTriggerKeywords(Skill s) {
        if (s.getTriggerKeywords() != null && !s.getTriggerKeywords().isEmpty()) return;
        List<String> kws = new ArrayList<>();
        String nm = s.getName() == null ? "" : s.getName().trim();
        if (!nm.isBlank()) kws.add(nm.toLowerCase());
        try {
            Object gen = generate(nm, s.getDescription(), s.getType(), s.getCategory()).get("triggerKeywords");
            if (gen instanceof List<?> l) for (Object o : l) {
                String k = String.valueOf(o).trim();
                if (!k.isEmpty() && !kws.contains(k) && kws.size() < 8) kws.add(k);
            }
        } catch (Exception e) { /* 模型不可用时保底只有技能名 */ }
        s.setTriggerKeywords(kws);
    }
}
