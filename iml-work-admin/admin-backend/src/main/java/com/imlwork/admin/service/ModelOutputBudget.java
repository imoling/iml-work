package com.imlwork.admin.service;

/**
 * 通道输出上限（max_tokens）的**产品默认值**。
 *
 * <p>为什么必须有默认、不能留空：留空＝用厂商默认，而厂商默认普遍是 4k。
 * 2026 年主流厂商已普遍转向<b>混合推理模型</b>——思考过程同样计入输出预算，
 * 预算不够时先被吃掉的是**正文**，接口仍返回 HTTP 200、`finish_reason=length`、
 * `content` 为空串。于是故障表现为"模型返回了空内容"，既不像报错也不像超时，
 * 排查要绕一大圈（2026-08-06 实测记录，同一条建脚本任务）：
 *
 * <pre>
 *   deepseek-v4-flash  max_tokens=8192  → 8192 全烧在思考，正文 0 字
 *   deepseek-v4-flash  max_tokens=16384 → 思考 5.6 万字，正文 0 字
 *   deepseek-v4-flash  max_tokens=32768 → 思考 7.1 万字 + 正文 9438 字，finish=stop ✅
 * </pre>
 *
 * <p>注意那条通道的 modelType 是 <b>chat</b>（名字带 flash）——所以<b>按档位给默认值救不了它</b>，
 * 标准档也必须给足预算。这就是默认值定在 32768 而不是 8192 的原因。
 *
 * <p>调大默认值不会多花钱：max_tokens 是**上限不是预留**，按实际生成量计费。
 * 反倒是给小了会白烧一整轮预算却拿不到正文（上例 8192 tokens 全部作废）。
 *
 * <p>厂商若不认这么大的上限（返回 400 且报文点名 max_tokens），
 * {@code ModelProxyService} 会摘掉该字段对同一通道重发一次——默认值绝不会把通道判死。
 */
public final class ModelOutputBudget {
    private ModelOutputBudget() {}

    /** 对话/推理档默认输出上限：够混合推理模型"思考完还有正文"。 */
    public static final int DEFAULT_CHAT = 32768;

    /** 视觉档默认：看图问答的答案通常很短，不需要大预算。 */
    public static final int DEFAULT_VISION = 8192;

    /**
     * 该通道应下发的输出上限。
     *
     * @param configured 管理端为通道配置的值（null/≤0 视为未配置）
     * @param modelType  通道类型（chat / reasoning / vision / image / video）
     * @return 应写入请求体的 max_tokens；返回 0 表示不下发该字段（生成类通道走厂商自有参数）
     */
    public static int resolve(Integer configured, String modelType) {
        if (configured != null && configured > 0) return configured;   // 管理员显式配置优先
        String t = modelType == null ? "" : modelType.trim().toLowerCase();
        if (ModelTiers.MEDIA_TYPES.contains(t)) return 0;              // 文生图/文生视频不吃 max_tokens
        if ("vision".equals(t)) return DEFAULT_VISION;
        return DEFAULT_CHAT;                                           // chat / reasoning / 未标注
    }

    /** 上游是否因为「输出上限」这个参数本身而拒绝（据此摘掉重发，而不是把通道判死）。 */
    public static boolean rejectedForMaxTokens(int status, String body) {
        if (status != 400 && status != 422) return false;
        String b = body == null ? "" : body.toLowerCase();
        return b.contains("max_tokens") || b.contains("max_output_tokens") || b.contains("maxtokens");
    }
}
