package com.imlwork.admin.service;

import com.imlwork.admin.model.Skill;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 技能包语义复审（agentic 审计，审计者独立于安装会话）：
 * 静态扫描拿不准的包（MEDIUM/REVIEW），让网关模型**读代码判行为**——回答
 * "这些脚本实际做什么、与技能声明的用途是否一致"，产出结构化意见附进安全报告，
 * 给确认卡与管理员审核页展示。
 *
 * 权限边界（不可违反）：模型意见**只能升级、不能降级**——判「危险」会把包推进
 * 人工复核档，判「一致」不会解除任何静态阻断。模型不可用/超时/输出不合法一律
 * 返回 null（fail-safe：按静态结论走，绝不因复审挂掉卡死安装链路）。
 */
@Service
public class SkillSemanticReviewService {

    /** 提示词体量上限：单文件截断 + 总量封顶，防超长包把网关打爆。 */
    private static final int PER_FILE_CAP = 2_000;
    private static final int TOTAL_CAP = 14_000;
    /** 复审硬超时：上游模型卡死时（实测 2026-08-13：JVM 无代理出不了网）安装预检被拖过客户端
     *  120s 预算直接超时——复审是锦上添花，绝不允许它把主流程拖死。 */
    private static final long REVIEW_TIMEOUT_SECONDS = 20;
    private static final Set<String> VERDICTS = Set.of("一致", "存疑", "危险");

    private final SkillLlmHelper llm;

    public SkillSemanticReviewService(SkillLlmHelper llm) {
        this.llm = llm;
    }

    /**
     * @param findings 静态扫描发现（用于告诉模型看哪里）
     * @return {verdict: 一致|存疑|危险, summary: 一句话依据}；失败返回 null
     */
    public Map<String, Object> review(Skill s, Map<String, String> bundle, List<SkillSecurityService.Finding> findings) {
        java.util.concurrent.CompletableFuture<Map<String, Object>> fut =
                java.util.concurrent.CompletableFuture.supplyAsync(() -> doReview(s, bundle, findings));
        try {
            return fut.get(REVIEW_TIMEOUT_SECONDS, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception e) {
            fut.cancel(true);
            return null;   // 超时/中断同样 fail-safe：按静态结论走
        }
    }

    private Map<String, Object> doReview(Skill s, Map<String, String> bundle, List<SkillSecurityService.Finding> findings) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append("你是企业技能包安全审计员。以下技能包将安装到一个「分身办公」平台：脚本只会在公司 Docker 沙箱内执行")
              .append("（依赖白名单、产物只能写 /out、碰不到宿主机），文档会被大模型阅读。\n\n")
              .append("技能声明：").append(nz(s.getName())).append(" —— ").append(nz(s.getDescription())).append("\n")
              .append("静态扫描已命中以下待判读项：\n");
            for (SkillSecurityService.Finding f : findings) {
                if ("LOW".equals(f.severity())) continue;
                sb.append("· [").append(f.severity()).append("] ").append(f.type()).append("：").append(f.detail()).append("\n");
            }
            sb.append("\n相关文件内容（截断）：\n");
            int used = 0;
            for (Map.Entry<String, String> e : bundle.entrySet()) {
                String p = e.getKey().toLowerCase();
                boolean script = p.endsWith(".py") || p.endsWith(".sh") || p.endsWith(".mjs") || p.endsWith(".js")
                        || p.endsWith(".cjs") || p.endsWith(".ts");
                if (!script) continue;   // 只带脚本：文档的注入面静态检测器已覆盖，塞进来只会撑爆提示词
                String body = e.getValue() == null ? "" : e.getValue();
                String cut = body.length() > PER_FILE_CAP ? body.substring(0, PER_FILE_CAP) + "\n…（截断）" : body;
                if (used + cut.length() > TOTAL_CAP) break;
                used += cut.length();
                sb.append("--- ").append(e.getKey()).append(" ---\n").append(cut).append("\n");
            }
            sb.append("\n请判断脚本的**实际行为**（不是含什么关键词）与技能声明的用途是否一致：")
              .append("有无数据外传、凭证收集、与用途无关的网络请求、解码后执行等恶意特征。")
              .append("只输出 JSON：{\"verdict\":\"一致|存疑|危险\",\"summary\":\"不超过 80 字的判定依据\"}");

            String content = llm.extractContent(llm.chat(sb.toString()));
            Map<String, Object> parsed = llm.parseLooseJson(content);
            String verdict = String.valueOf(parsed.getOrDefault("verdict", "")).trim();
            if (!VERDICTS.contains(verdict)) return null;
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("verdict", verdict);
            out.put("summary", String.valueOf(parsed.getOrDefault("summary", "")).trim());
            return out;
        } catch (Exception e) {
            return null;   // fail-safe：复审失败不影响静态结论，也绝不卡死安装链路
        }
    }

    private static String nz(String x) { return x == null ? "" : x; }
}
