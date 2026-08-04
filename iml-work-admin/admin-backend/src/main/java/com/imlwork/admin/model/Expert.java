package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "expert")
public class Expert {

    @Id
    private String id;

    private String title;

    @Column(length = 1000)
    private String spec;

    @Column(columnDefinition = "text")
    private String description;

    /**
     * Skill packages bound to this expert (many-to-many)。
     * LAZY：open-in-view=false，事务外序列化前必须在 Service 内显式初始化（get/claim/fingerprint 已做）；
     * 列表接口不再吐实体，走 ExpertSummary 投影，不触发本集合。
     */
    @ManyToMany(fetch = FetchType.LAZY, cascade = {CascadeType.PERSIST, CascadeType.MERGE})
    @JoinTable(
            name = "expert_skill",
            joinColumns = @JoinColumn(name = "expert_id"),
            inverseJoinColumns = @JoinColumn(name = "skill_id"))
    private List<Skill> skills = new ArrayList<>();

    /** Corporate knowledge-base categories this expert is allowed to retrieve. */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> knowledgeCategories = new ArrayList<>();

    /** 是否允许该岗位分身联网检索。开启后分身可自主判断是否上网找答案。 */
    private boolean webSearchEnabled = false;

    /** 岗位 SOUL · 我的原则（企业统一定义，客户端只读展示；每条一行）。 */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> principles = new ArrayList<>();

    /** 岗位 SOUL · 我的工作方式（企业统一定义，客户端只读展示；每条一行）。 */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> workStyle = new ArrayList<>();

    /** 岗位业务域侧重（如 ERM/CRM/OA）：本体解析优先在侧重域内匹配——领域语料随岗位配置，不写死在客户端。 */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> ontologyDomains = new ArrayList<>();

    /**
     * 可协作岗位 id 列表（agent teams）：该岗位分身遇到跨领域问题时，可以请教这些岗位。
     *
     * 为什么挂在 Expert 上而不是新建 Team 实体：Expert 本身已经是一个完整的 agent 定义
     * （角色 + 技能 + 知识域 + 联网权限 + SOUL + 本体域），再抽一层"团队"只会多出一个没人配的概念。
     * 关系是**单向**的（A 可以请教 B，不代表 B 能请教 A）——这符合真实的组织协作：
     * 销售可以问法务合同条款，法务不需要反过来问销售。
     *
     * 用 text 列存（StringListConverter）且可空：ddl-auto=update 对非空表加**可空 text 列**是安全的，
     * 不踩「原始类型字段 ADD COLUMN NOT NULL 静默失败」那个坑（见 CLAUDE.md 已知坑）。
     */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> collaborators = new ArrayList<>();

    public Expert() {}

    public Expert(String id, String title, String spec, String description, List<Skill> skills) {
        this.id = id;
        this.title = title;
        this.spec = spec;
        this.description = description;
        this.skills = skills;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public String getSpec() { return spec; }
    public void setSpec(String spec) { this.spec = spec; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public List<Skill> getSkills() { return skills; }
    public void setSkills(List<Skill> skills) { this.skills = skills; }

    public List<String> getKnowledgeCategories() { return knowledgeCategories; }
    public void setKnowledgeCategories(List<String> knowledgeCategories) { this.knowledgeCategories = knowledgeCategories; }

    public boolean isWebSearchEnabled() { return webSearchEnabled; }
    public void setWebSearchEnabled(boolean webSearchEnabled) { this.webSearchEnabled = webSearchEnabled; }

    public List<String> getPrinciples() { return principles; }
    public void setPrinciples(List<String> principles) { this.principles = principles; }

    public List<String> getWorkStyle() { return workStyle; }
    public void setWorkStyle(List<String> workStyle) { this.workStyle = workStyle; }

    public List<String> getOntologyDomains() { return ontologyDomains; }
    public void setOntologyDomains(List<String> ontologyDomains) { this.ontologyDomains = ontologyDomains; }

    public List<String> getCollaborators() { return collaborators; }
    public void setCollaborators(List<String> collaborators) { this.collaborators = collaborators; }
}
