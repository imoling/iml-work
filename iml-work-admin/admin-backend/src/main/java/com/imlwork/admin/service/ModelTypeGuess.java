package com.imlwork.admin.service;

import java.util.Locale;

/**
 * 由模型名推断通道类型（chat / reasoning）。
 *
 * <p><b>这是启发式，不是厂商事实。</b>OpenAI 兼容的 /models 接口只返回 id，没有任何
 * "这是推理档"的元数据字段，各厂商也没有统一约定。所以这里只能按命名习惯猜，
 * 猜错由管理员在登记表单里改——批量登记面板必须保留类型下拉，不允许直接静默入库。
 *
 * <p>规则宁缺勿滥：漏判只是少一个推理通道（管理员手改即可），误判则会把日常对话
 * 打到按推理档计费的贵模型上，代价不对等。因此只收录**明确以推理为卖点**的命名。
 */
public final class ModelTypeGuess {
    private ModelTypeGuess() {}

    public static final String CHAT = "chat";
    public static final String REASONING = "reasoning";

    /**
     * 强档命名特征。注意这里判的是<b>能力档位</b>（该不该承接深度调研这类重任务），
     * 不是"会不会产生思维链"——2026 年主流厂商已普遍转向混合推理模型，
     * 实测 deepseek-v4-flash 回答"1+1"也会花 22 个 token 思考，
     * 用 reasoning_tokens 区分快档/强档已经完全失效（见 ModelProviderService.probeModelTypes）。
     *
     * <p>两类特征：
     * <ul>
     *   <li>显式推理模型：deepseek-reasoner/r1、OpenAI o1~o9、*-thinking、QwQ、GLM-Z1、
     *       MiniMax-M1/M2、Mistral Magistral；</li>
     *   <li>同系列里的强档命名：pro / max / plus / ultra / opus / large —— 与
     *       flash / mini / lite / turbo / air 相对。deepseek-v4-pro、gemini-*-pro、
     *       qwen-plus、claude-*-opus 都靠这条认出来。</li>
     * </ul>
     * 用词边界约束，避免 "r1"/"pro" 这类短串误伤（如 xxx-r1x、prompt-xx）。
     */
    private static final java.util.regex.Pattern REASONING_NAME = java.util.regex.Pattern.compile(
            "(reasoner|reasoning|thinking|magistral|qwq)"
            + "|(^|[-_/])(o[1-9])([-_.]|$)"
            + "|(^|[-_/])(r1|z1)([-_.]|$)"
            + "|minimax[-_]?m[12]([-_.]|$)"
            + "|(^|[-_/])(pro|max|plus|ultra|opus|large)([-_.]|$)");

    /**
     * 非对话模型（嵌入 / 重排 / 语音 / 图像 / 审核）。拉取上游列表时它们会混在里面，
     * 但根本不能当对话通道用——而且 text-embedding-3-large、bge-reranker-large 这种
     * 名字里带 large，会被强档规则误判成推理档。先排除掉。
     */
    private static final java.util.regex.Pattern NON_CHAT = java.util.regex.Pattern.compile(
            "embed|rerank|^bge|whisper|^tts|audio|speech|dall|stable-diffusion|moderation|guard"
            // 文生图/文生视频：名字里带 image/video/vision-gen 的生成模型不是对话模型。
            // 漏了这条，agnes-image-2.0-flash / agnes-video-v2.0 会被标成"标准档"混进对话候选，
            // 用户在客户端一选就报错（实测截图里就是这样）。
            // 用 -? 允许 imagen / image-gen / video-v2 各种写法；"vision" 不在此列——
            // 视觉理解模型是**能对话**的（看图问答），只是另一个档位。
            + "|imagen|[-_]image[-_]?|[-_]video[-_]?|^image[-_]|^video[-_]|sora|kling|veo");

    /** 该模型能否作为对话通道；嵌入/重排/语音/图像模型返回 false（前端默认不勾选）。 */
    public static boolean isChatCapable(String modelName) {
        if (modelName == null || modelName.isBlank()) return false;
        return !NON_CHAT.matcher(modelName.trim().toLowerCase(Locale.ROOT)).find();
    }

    /** 猜一个模型名的通道类型；拿不准一律回 chat（见类注释的不对等代价）。 */
    public static String of(String modelName) {
        if (modelName == null || modelName.isBlank()) return CHAT;
        String n = modelName.trim().toLowerCase(Locale.ROOT);
        if (!isChatCapable(n)) return CHAT;          // 非对话模型不参与档位判定
        return REASONING_NAME.matcher(n).find() ? REASONING : CHAT;
    }

    /**
     * 该类型下的建议逻辑路由名。
     *
     * <p>推理档**必须**与快档分开：corp-default 走的是 routeKey 匹配分支
     * （见 ModelRouterService.candidates），两个通道同名就都进候选池，
     * 日常对话会被负载均衡打到贵的推理模型上。而 corp-reasoning 别名走的是
     * modelType 过滤分支，与 routeKey 无关——所以这里给推理档单独命名是安全的。
     */
    public static String suggestedRouteKey(String modelType) {
        return ModelTiers.byModelType(modelType).alias();
    }
}
