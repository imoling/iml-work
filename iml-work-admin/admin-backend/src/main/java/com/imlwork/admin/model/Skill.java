package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "skill")
public class Skill {

    @Id
    private String id;

    private String name;

    private String type; // 执行引擎: playwright, python-sandbox, onnx-bge, nut-js

    /** 业务分类，如 办公自动化 / 财务税务 / 知识管理 / 数据处理 / 通用工具。 */
    private String category;

    /** 生命周期状态: DRAFT 草稿 | PUBLISHED 已发布 | DISABLED 已停用。 */
    private String status = "PUBLISHED";

    /** 语义化版本号，如 1.0.0。 */
    private String version = "1.0.0";

    @Column(length = 1000)
    private String description;

    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> triggerKeywords = new ArrayList<>();

    @Column(columnDefinition = "text")
    private String sopContent;

    /** Executable RPA / sandbox script body edited in the SkillsHub Monaco editor. */
    @Column(columnDefinition = "text")
    private String code;

    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> allowedRoles = new ArrayList<>();

    /** preset | upload-md | upload-zip — provenance of the skill package. */
    private String source = "preset";

    /**
     * 绑定的目标业务系统（业务系统连接的 id）。运行时由客户端据此解析系统地址，
     * 并注入员工在本地配置的个人登录会话。为空表示不依赖特定业务系统的通用技能。
     */
    private String targetSystemId;

    /**
     * 浏览器实操录制产生的操作脚本（JSON 字符串）：{"steps":[{action,selector,value,fieldName,label,url}],"fields":[{name,label,type}]}。
     * 运行时客户端据此弹出确认表单并在无头浏览器中确定性回放，替代凭标签猜测的填充。
     */
    @Column(columnDefinition = "text")
    private String actionScript;

    /**
     * 技能类型：read=读取/查看类（纯导航，客户端走"打开页面+按导航直达+抓取"，更稳）；
     * write=写入/操作类（含填写/选择，按确认参数确定性回放）。录制时由引擎判定。
     */
    private String skillKind;

    /**
     * 录制到的导航目标哈希路由（如 #/oa/todo/list）。读取类技能据此直达目标子页再抓取，
     * 覆盖折叠菜单/占位 href(#/000) 等抓不到入口的场景。
     */
    private String navHash;

    /**
     * 技能包整目录文件（JSON：{相对路径: 文本内容}）。从 GitHub 目录导入时抓取 SKILL.md +
     * scripts/** 一并存下，供沙箱执行时铺进虚拟文件系统。单文件技能此字段为空。
     */
    @Column(columnDefinition = "text")
    private String bundle;

    private LocalDateTime updatedAt = LocalDateTime.now();

    public Skill() {}

    public String getBundle() { return bundle; }
    public void setBundle(String bundle) { this.bundle = bundle; }

    public Skill(String id, String name, String type) {
        this.id = id;
        this.name = name;
        this.type = type;
    }

    public Skill(String id, String name, String type, String description, List<String> triggerKeywords,
                 String sopContent, List<String> allowedRoles) {
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

    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getVersion() { return version; }
    public void setVersion(String version) { this.version = version; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public List<String> getTriggerKeywords() { return triggerKeywords; }
    public void setTriggerKeywords(List<String> triggerKeywords) { this.triggerKeywords = triggerKeywords; }

    public String getSopContent() { return sopContent; }
    public void setSopContent(String sopContent) { this.sopContent = sopContent; }

    public String getCode() { return code; }
    public void setCode(String code) { this.code = code; }

    public List<String> getAllowedRoles() { return allowedRoles; }
    public void setAllowedRoles(List<String> allowedRoles) { this.allowedRoles = allowedRoles; }

    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }

    public String getTargetSystemId() { return targetSystemId; }
    public void setTargetSystemId(String targetSystemId) { this.targetSystemId = targetSystemId; }

    public String getSkillKind() { return skillKind; }
    public void setSkillKind(String skillKind) { this.skillKind = skillKind; }

    public String getNavHash() { return navHash; }
    public void setNavHash(String navHash) { this.navHash = navHash; }

    public String getActionScript() { return actionScript; }
    public void setActionScript(String actionScript) { this.actionScript = actionScript; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
