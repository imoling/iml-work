package com.imlwork.admin.model;

public class SyncFile {
    private String name;
    private String path;
    private String summary;
    private boolean synced;
    private long sizeBytes;
    private String employeeName;

    public SyncFile() {}

    public SyncFile(String name, String path, String summary, boolean synced, long sizeBytes, String employeeName) {
        this.name = name;
        this.path = path;
        this.summary = summary;
        this.synced = synced;
        this.sizeBytes = sizeBytes;
        this.employeeName = employeeName;
    }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getPath() { return path; }
    public void setPath(String path) { this.path = path; }

    public String getSummary() { return summary; }
    public void setSummary(String summary) { this.summary = summary; }

    public boolean isSynced() { return synced; }
    public void setSynced(boolean synced) { this.synced = synced; }

    public long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(long sizeBytes) { this.sizeBytes = sizeBytes; }

    public String getEmployeeName() { return employeeName; }
    public void setEmployeeName(String employeeName) { this.employeeName = employeeName; }
}
