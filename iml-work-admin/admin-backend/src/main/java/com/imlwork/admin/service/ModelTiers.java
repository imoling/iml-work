package com.imlwork.admin.service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 档位定义的**唯一来源**。
 *
 * <p>为什么要收敛：档位（corp-default / corp-reasoning）此前散落在三端至少 6 处——
 * 后端的路由判据与清单下发、管理端的选择器与总览卡、客户端 composer 的档位标签，
 * 各自硬编码一份别名和文案。加一个新档位要改 6 个地方，漏一处就是"某一端看不到该档位"，
 * 而这类不一致在编译期毫无信号。
 *
 * <p>现在两端都从接口取：客户端读 {@code GET /api/v1/model/models} 的 tiers 字段
 * （随网关清单一起下发，不额外发请求），管理端读 {@code GET /api/v1/model/providers/tiers}。
 * 新增档位只改这个文件。
 *
 * <p>注意两个档位的**路由机制并不对称**（见 ModelRouterService.candidates）：
 * corp-default 走 routeKey 字面匹配，corp-reasoning 走 modelType 过滤。
 * 这里把 alias 与 modelType 一并给出，消费端不需要知道这个差异。
 */
public final class ModelTiers {
    private ModelTiers() {}

    /**
     * @param fallback 是否为兜底档。兜底档恒可用：网关无条件下发 corp-default，
     *                 且任何请求匹配不到具体通道时都会回落到全池（ModelRouterService 的 fail-open），
     *                 所以哪怕一条 chat 类型通道都没有，标准档依然是能用的。
     */
    public record Tier(String key, String alias, String name, String use, String modelType, boolean fallback) {}

    public static final List<Tier> ALL = List.of(
            new Tier("standard", "corp-default", "标准档",
                    "日常对话、技能执行、定时任务", ModelTypeGuess.CHAT, true),
            new Tier("reasoning", "corp-reasoning", "推理档",
                    "复杂分析与长链推理，更慢但更准", ModelTypeGuess.REASONING, false),
            new Tier("vision", "corp-vision", "视觉档",
                    "看图：截图、扫描件、图表、界面", "vision", false));

    /**
     * 非对话的**能力类型**：图片生成、视频生成。
     *
     * 与 ALL 里的档位分开：档位是"同一次对话该用哪个模型"（会下发给客户端选择器），
     * 而这些是"这条通道用来干别的事"——不参与对话路由、不出现在档位选择器里，
     * 但必须是**合法的 modelType**，否则写入校验会把它们压成 chat，
     * /images/generations 就永远筛不出对应通道（加档位校验时差点踩到）。
     */
    public static final java.util.Set<String> MEDIA_TYPES = java.util.Set.of("image", "video");

    /**
     * 非对话能力的通道定义。复用 Tier 记录只是为了共用序列化，语义不同：
     * 这些**不是对话档位**，客户端 composer 的模型选择器绝不能出现它们
     * （员工不会想"这轮对话用文生图模型"）。所以只进 describeAll（管理端配置界面），
     * 不进 describe（随网关清单下发给客户端的那份）。
     */
    public static final List<Tier> MEDIA = List.of(
            new Tier("image", "corp-image", "图片生成", "文生图：配图、插画、海报底图", "image", false),
            new Tier("video", "corp-video", "视频生成", "文生视频：短片段、演示动画", "video", false));

    /** 该类型是否为合法的通道类型（档位 或 非对话能力）。 */
    public static boolean isValidType(String modelType) {
        if (modelType == null || modelType.isBlank()) return false;
        String t = modelType.trim();
        return MEDIA_TYPES.contains(t.toLowerCase())
                || ALL.stream().anyMatch(x -> x.modelType().equalsIgnoreCase(t));
    }

    /** 按别名找档位（路由分支用；找不到返回 null 表示"不是档位别名，按普通模型名处理"）。 */
    public static Tier byAlias(String alias) {
        if (alias == null || alias.isBlank()) return null;
        return ALL.stream().filter(t -> t.alias().equalsIgnoreCase(alias.trim())).findFirst().orElse(null);
    }

    /** 按通道类型找档位；未知类型归兜底档。加档位后这里必须泛化——写死判 REASONING 会让
     *  vision 通道被分到 corp-default 路由名（批量登记时就错了）。 */
    public static Tier byModelType(String modelType) {
        if (modelType != null && !modelType.isBlank()) {
            for (Tier t : ALL) {
                if (t.modelType().equalsIgnoreCase(modelType.trim())) return t;
            }
        }
        return ALL.get(0);
    }

    /**
     * 序列化给前端。availableTypes 传当前已启用通道的 modelType 集合，
     * 据此标注每档是否真有通道——客户端 composer 只显示 available 的档位，
     * 免得员工选中一个空路由（网关会 fail-open 回默认池，但用户以为自己换了模型）。
     * 传 null 表示不关心可用性（管理端配置场景：没通道也要能选）。
     */
    /**
     * 管理端配置界面用：对话档位 + 非对话能力，各带 kind 区分。
     * 管理员在编辑通道时要能选"这条是文生图通道"——选不了就只能存成 chat，
     * 而 chat 的通道会被拉进对话候选池，一条文生图模型收到对话请求必然失败。
     */
    public static List<Map<String, Object>> describeAll() {
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (Map<String, Object> m : describe(null)) { m.put("kind", "tier"); out.add(m); }
        for (Tier t : MEDIA) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("key", t.key());
            m.put("alias", t.alias());
            m.put("name", t.name());
            m.put("use", t.use());
            m.put("modelType", t.modelType());
            m.put("fallback", false);
            m.put("available", true);
            m.put("kind", "capability");
            out.add(m);
        }
        return out;
    }

    public static List<Map<String, Object>> describe(java.util.Set<String> availableTypes) {
        return ALL.stream().map(t -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("key", t.key());
            m.put("alias", t.alias());
            m.put("name", t.name());
            m.put("use", t.use());
            m.put("modelType", t.modelType());
            // 消费端据此选成员判据：兜底档按 routeKey 字面匹配，其余按 modelType 过滤
            // （与 ModelRouterService.candidates 的两条分支一一对应）。
            m.put("fallback", t.fallback());
            m.put("available", t.fallback() || availableTypes == null || availableTypes.stream()
                    .anyMatch(x -> t.modelType().equalsIgnoreCase(x)));
            return m;
        }).toList();
    }
}
