package com.imlwork.admin.service;

import com.imlwork.admin.model.Skill;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SKILL.md frontmatter 解析。第三方技能的 frontmatter 写法五花八门，
 * 解析错了不会报错——只会让技能带着一个错误的 description 静默装进来，
 * 而 description 正是语义路由的判据。
 */
class SkillPackageServiceTest {

    private final SkillPackageService svc = new SkillPackageService(null, null, null);

    @Test
    void 单行描述照常解析() {
        Skill s = svc.parseSkillMarkdown("""
                ---
                name: demo
                description: 一句话描述
                ---
                正文
                """);
        assertThat(s.getName()).isEqualTo("demo");
        assertThat(s.getDescription()).isEqualTo("一句话描述");
    }

    @Test
    void 块标量竖线保留换行() {
        // 回归钉子：曾把 description 取成字面的 "|"（实测装 Humanizer-zh 时踩到）
        Skill s = svc.parseSkillMarkdown("""
                ---
                name: demo
                description: |
                  第一行
                  第二行
                ---
                正文
                """);
        assertThat(s.getDescription()).isEqualTo("第一行\n第二行");
    }

    @Test
    void 块标量折叠号并成空格() {
        Skill s = svc.parseSkillMarkdown("""
                ---
                name: demo
                description: >
                  前半句
                  后半句
                ---
                """);
        assertThat(s.getDescription()).isEqualTo("前半句 后半句");
    }

    @Test
    void 块标量后面的字段不被吞掉() {
        // 缩进退回即块结束——否则 version 会被并进 description
        Skill s = svc.parseSkillMarkdown("""
                ---
                name: demo
                description: |-
                  多行描述
                version: 2.0.0
                ---
                """);
        assertThat(s.getDescription()).isEqualTo("多行描述");
        assertThat(s.getVersion()).isEqualTo("2.0.0");
    }

    @Test
    void 触发词列表照常解析() {
        Skill s = svc.parseSkillMarkdown("""
                ---
                name: demo
                description: |
                  多行
                  描述
                trigger_keywords:
                  - 润色
                  - 改写
                ---
                """);
        assertThat(s.getTriggerKeywords()).containsExactly("润色", "改写");
        assertThat(s.getDescription()).isEqualTo("多行\n描述");
    }
}
