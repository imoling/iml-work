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

    /** Skill packages bound to this expert (many-to-many, single EAGER bag). */
    @ManyToMany(fetch = FetchType.EAGER, cascade = {CascadeType.PERSIST, CascadeType.MERGE})
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
}
