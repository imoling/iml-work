package com.imlwork.admin.model;

import java.util.List;

public class Skill {
    private String id;
    private String name;
    private String type; // e.g. playwright, python-sandbox
    private String description;
    private List<String> triggerKeywords;
    private String sopContent;
    private List<String> allowedRoles;

    public Skill() {}

    public Skill(String id, String name, String type) {
        this.id = id;
        this.name = name;
        this.type = type;
    }

    public Skill(String id, String name, String type, String description, List<String> triggerKeywords, String sopContent, List<String> allowedRoles) {
        this.id = id;
        this.name = name;
        this.type = type;
        this.description = description;
        this.triggerKeywords = triggerKeywords;
        this.sopContent = sopContent;
        this.allowedRoles = allowedRoles;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public List<String> getTriggerKeywords() { return triggerKeywords; }
    public void setTriggerKeywords(List<String> triggerKeywords) { this.triggerKeywords = triggerKeywords; }

    public String getSopContent() { return sopContent; }
    public void setSopContent(String sopContent) { this.sopContent = sopContent; }

    public List<String> getAllowedRoles() { return allowedRoles; }
    public void setAllowedRoles(List<String> allowedRoles) { this.allowedRoles = allowedRoles; }
}
