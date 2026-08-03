package com.imlwork.admin.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 档位推断规则表的回归钉子。
 *
 * <p>这张表判的是**能力档位**（该不该承接深度调研这类重任务），不是"会不会产生思维链"——
 * 2026 年主流厂商已普遍转向混合推理模型，实测 deepseek-v4-flash 回答"1+1"也会花 22 个
 * token 思考，reasoning_tokens 区分不了快档与强档（见 ModelProviderService.probeModelTypes）。
 *
 * <p>为什么必须有测试：规则是正则，改一条就可能连坐一片，而**误判代价不对等**——
 * 把快档误判成推理档，日常对话就按推理档计费；漏判只是少一个推理通道，管理员手改即可。
 * 下面每条断言都对应一个真实模型名，删规则前先看这里会不会红。
 */
class ModelTypeGuessTest {

    // ── 强档：显式推理模型 ────────────────────────────────────────────────────
    @ParameterizedTest
    @ValueSource(strings = {
            "deepseek-reasoner", "deepseek-r1", "DeepSeek-R1-0528",
            "o1", "o1-preview", "o3-mini", "o4-mini",
            "qwq-32b", "glm-z1-air", "kimi-k2-thinking", "qwen3-235b-thinking",
            "minimax-m1", "minimax-m2", "MiniMax-M2", "magistral-small",
    })
    @DisplayName("显式推理模型判为推理档")
    void explicitReasoningModels(String model) {
        assertEquals(ModelTypeGuess.REASONING, ModelTypeGuess.of(model), model);
    }

    // ── 强档：同系列里的"强"命名 ──────────────────────────────────────────────
    @ParameterizedTest
    @ValueSource(strings = { "deepseek-v4-pro", "gemini-1.5-pro", "qwen-plus", "qwen-max", "claude-3-opus" })
    @DisplayName("同系列强档命名判为推理档（pro/plus/max/opus）")
    void strongTierNames(String model) {
        assertEquals(ModelTypeGuess.REASONING, ModelTypeGuess.of(model), model);
    }

    // ── 快档 ────────────────────────────────────────────────────────────────
    @ParameterizedTest
    @ValueSource(strings = {
            "deepseek-chat", "deepseek-v4-flash", "gemini-2.0-flash", "qwen-turbo",
            "glm-4.6", "moonshot-v1-128k", "claude-sonnet-4-5", "llama-3.1-70b",
    })
    @DisplayName("轻量/中档命名判为快档")
    void chatTierNames(String model) {
        assertEquals(ModelTypeGuess.CHAT, ModelTypeGuess.of(model), model);
    }

    /**
     * gpt-4o 系列是这张表最容易踩的雷：o 系列规则若不加词边界，"4o" 里的 o 会被当成 o1~o9，
     * 把 OpenAI 最常用的日常对话模型整片误判成推理档。
     */
    @ParameterizedTest
    @ValueSource(strings = { "gpt-4o", "gpt-4o-mini", "chatgpt-4o-latest", "gpt-4-turbo", "gpt-4.1" })
    @DisplayName("gpt-4o 系列不被 o[1-9] 规则误伤")
    void gpt4oNotMistakenForOSeries(String model) {
        assertEquals(ModelTypeGuess.CHAT, ModelTypeGuess.of(model), model);
    }

    /**
     * 嵌入/重排模型名里常带 large，会被强档规则误判；它们根本不能当对话通道，
     * 必须先被 isChatCapable 挡掉。
     */
    @ParameterizedTest
    @ValueSource(strings = {
            "text-embedding-3-large", "bge-m3:latest", "bge-reranker-large",
            "whisper-1", "tts-1-hd", "dall-e-3", "omni-moderation-latest",
    })
    @DisplayName("非对话模型：不可作通道，且不被 large 规则误判成推理档")
    void nonChatModels(String model) {
        assertFalse(ModelTypeGuess.isChatCapable(model), model + " 不该能作对话通道");
        assertEquals(ModelTypeGuess.CHAT, ModelTypeGuess.of(model), model + " 不该判成推理档");
    }

    @Test
    @DisplayName("对话模型 isChatCapable 为真")
    void chatCapablePositive() {
        assertTrue(ModelTypeGuess.isChatCapable("deepseek-v4-pro"));
        assertTrue(ModelTypeGuess.isChatCapable("gpt-4o"));
        // 视觉理解模型**能**对话（看图问答），只是另一个档位——别跟文生图混为一谈
        assertTrue(ModelTypeGuess.isChatCapable("gpt-4o-vision"));
        assertTrue(ModelTypeGuess.isChatCapable("agnes-2.5-pro"));
    }

    @Test
    @DisplayName("文生图/文生视频不是对话模型——漏判会让它混进对话候选，用户一选就报错")
    void chatCapableRejectsMediaGen() {
        // 实测踩到：客户端模型选择器把这两个标成"标准档"（截图 2026-08-03）
        assertFalse(ModelTypeGuess.isChatCapable("agnes-image-2.0-flash"));
        assertFalse(ModelTypeGuess.isChatCapable("agnes-video-v2.0"));
        assertFalse(ModelTypeGuess.isChatCapable("agnes-image-2.1-flash"));
        assertFalse(ModelTypeGuess.isChatCapable("imagen-3.0"));
        assertFalse(ModelTypeGuess.isChatCapable("sora-turbo"));
        assertFalse(ModelTypeGuess.isChatCapable("kling-v1"));
        assertFalse(ModelTypeGuess.isChatCapable("veo-2"));
        assertFalse(ModelTypeGuess.isChatCapable("dall-e-3"));
        // 反例：名字里含 image 但是**理解**类的不能误伤
        assertTrue(ModelTypeGuess.isChatCapable("gpt-4o"));
        assertTrue(ModelTypeGuess.isChatCapable("qwen-vl-max"));
    }

    @ParameterizedTest
    @CsvSource({ "chat,corp-default", "reasoning,corp-reasoning", "REASONING,corp-reasoning", "'',corp-default" })
    @DisplayName("建议路由名：推理档必须与快档分开，否则日常对话会被打到贵模型")
    void suggestedRouteKey(String type, String expected) {
        assertEquals(expected, ModelTypeGuess.suggestedRouteKey(type));
    }

    @Test
    @DisplayName("空值兜底：不炸、按快档处理")
    void blankInputs() {
        assertEquals(ModelTypeGuess.CHAT, ModelTypeGuess.of(null));
        assertEquals(ModelTypeGuess.CHAT, ModelTypeGuess.of("  "));
        assertFalse(ModelTypeGuess.isChatCapable(null));
        assertFalse(ModelTypeGuess.isChatCapable(""));
    }
}
