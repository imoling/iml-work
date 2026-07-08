package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 沙箱执行审计：一次性容器"创建→执行→销毁"留痕。容器跑完即毁、在线监控看不到历史，
 * 故每次 exec 落一条：时间/容器id/镜像/时长/成败/产物/网络隔离，供管理端回溯与合规审计。
 * 只存执行元信息与截断预览，不存完整代码/输出（避免表膨胀，够溯源即可）。
 */
@Entity
@Table(name = "sandbox_exec_audit", indexes = @Index(name = "idx_sandbox_audit_created", columnList = "createdAt"))
public class SandboxExecAudit {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private LocalDateTime createdAt = LocalDateTime.now();

    private String source;         // 触发来源（技能名/自检等，调用方可传，缺省"未标注"）
    private String containerId;    // 短容器 id（销毁前记录）
    private String image;          // 基础镜像
    private String packages;       // 本次装的包（逗号分隔）
    private long durationMs;       // 执行耗时
    private boolean success;       // 是否成功（无 Traceback / 未超时）
    private boolean networkIsolated;
    private String status;         // done | failed | timeout | disabled
    private int fileCount;         // 回传产物数
    private String fileNames;      // 产物文件名（逗号分隔）

    @Column(columnDefinition = "text") private String codePreview;   // 代码前 500 字
    @Column(columnDefinition = "text") private String stdoutPreview; // stdout 前 500 字
    @Column(columnDefinition = "text") private String stderrPreview; // stderr 前 500 字

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public String getContainerId() { return containerId; }
    public void setContainerId(String containerId) { this.containerId = containerId; }
    public String getImage() { return image; }
    public void setImage(String image) { this.image = image; }
    public String getPackages() { return packages; }
    public void setPackages(String packages) { this.packages = packages; }
    public long getDurationMs() { return durationMs; }
    public void setDurationMs(long durationMs) { this.durationMs = durationMs; }
    public boolean isSuccess() { return success; }
    public void setSuccess(boolean success) { this.success = success; }
    public boolean isNetworkIsolated() { return networkIsolated; }
    public void setNetworkIsolated(boolean networkIsolated) { this.networkIsolated = networkIsolated; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public int getFileCount() { return fileCount; }
    public void setFileCount(int fileCount) { this.fileCount = fileCount; }
    public String getFileNames() { return fileNames; }
    public void setFileNames(String fileNames) { this.fileNames = fileNames; }
    public String getCodePreview() { return codePreview; }
    public void setCodePreview(String codePreview) { this.codePreview = codePreview; }
    public String getStdoutPreview() { return stdoutPreview; }
    public void setStdoutPreview(String stdoutPreview) { this.stdoutPreview = stdoutPreview; }
    public String getStderrPreview() { return stderrPreview; }
    public void setStderrPreview(String stderrPreview) { this.stderrPreview = stderrPreview; }
}
