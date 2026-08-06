package com.imlwork.admin.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 输出预算默认值的回归钉子。
 *
 * <p>为什么值得钉：预算给小了的失败是**静默的**——上游返回 HTTP 200、`finish_reason=length`、
 * `content` 空串，客户端只能报一句"模型返回了空内容"，谁也看不出是预算被思考过程吃光了
 * （2026-08-06 实测：deepseek-v4-flash 在 8k/16k 下正文 0 字，32k 才吐出 9438 字正文）。
 * 有人日后把默认值调回 8192 "省钱"时，这里会先红——而 max_tokens 是上限不是预留，调大并不多花钱。
 */
class ModelOutputBudgetTest {

    @Test
    @DisplayName("未配置时按类型给默认：对话/推理 32768，视觉 8192")
    void defaultsByType() {
        assertEquals(32768, ModelOutputBudget.resolve(null, "chat"));
        assertEquals(32768, ModelOutputBudget.resolve(null, "reasoning"));
        assertEquals(8192, ModelOutputBudget.resolve(null, "vision"));
    }

    @Test
    @DisplayName("标准档（chat）也必须给足预算：混合推理模型的 modelType 就是 chat")
    void chatTierMustBeGenerous() {
        // deepseek-v4-flash 名字带 flash → 判为 chat，却要 32768 才吐得出正文。
        // 若有人把 chat 默认改小，这条会红。
        assertEquals(ModelOutputBudget.DEFAULT_CHAT, ModelOutputBudget.resolve(null, "chat"));
        assertTrue(ModelOutputBudget.DEFAULT_CHAT >= 32768, "chat 默认预算不得小于 32768");
    }

    @ParameterizedTest
    @ValueSource(strings = {"image", "video"})
    @DisplayName("文生图/文生视频通道不下发 max_tokens（返回 0）")
    void mediaChannelsGetNoCap(String type) {
        assertEquals(0, ModelOutputBudget.resolve(null, type));
    }

    @Test
    @DisplayName("管理员显式配置优先于默认；0/负数视为未配置")
    void configuredWins() {
        assertEquals(4096, ModelOutputBudget.resolve(4096, "chat"));
        assertEquals(32768, ModelOutputBudget.resolve(0, "chat"));
        assertEquals(32768, ModelOutputBudget.resolve(-1, "chat"));
    }

    @Test
    @DisplayName("类型缺失/大小写/空白都不影响判定")
    void typeNormalization() {
        assertEquals(32768, ModelOutputBudget.resolve(null, null));
        assertEquals(32768, ModelOutputBudget.resolve(null, "  CHAT "));
        assertEquals(8192, ModelOutputBudget.resolve(null, "Vision"));
        assertEquals(0, ModelOutputBudget.resolve(null, " IMAGE "));
    }

    @ParameterizedTest
    @CsvSource({
            "400, '{\"error\":{\"message\":\"max_tokens is too large\"}}', true",
            "400, '{\"error\":{\"message\":\"max_output_tokens exceeds model limit\"}}', true",
            "422, '{\"detail\":\"maxTokens invalid\"}', true",
            "400, '{\"error\":{\"message\":\"invalid api key\"}}', false",
            "403, '{\"error\":{\"message\":\"max_tokens too large\"}}', false",
            "200, '{\"choices\":[]}', false",
    })
    @DisplayName("只有「因输出上限被拒」才摘掉重发——别把鉴权失败也当参数问题重试")
    void rejectionDetection(int status, String body, boolean expected) {
        assertEquals(expected, ModelOutputBudget.rejectedForMaxTokens(status, body));
    }

    @Test
    @DisplayName("报文为 null 不炸")
    void nullBodySafe() {
        assertFalse(ModelOutputBudget.rejectedForMaxTokens(400, null));
    }
}
