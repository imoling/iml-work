package com.imlwork.admin.model;

import java.util.List;

public class Expert {
    private String id;
    private String title;
    private String spec;
    private String description;
    private List<Skill> skills;

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
}
