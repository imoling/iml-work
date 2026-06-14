package com.imlwork.admin.model;

import jakarta.persistence.*;

/**
 * Singleton sandbox runtime configuration (always row id = 1). Mirrors the
 * SandboxManager admin form: runtime mode, docker remote endpoint and resource
 * quotas applied when a private docker sandbox is provisioned.
 */
@Entity
@Table(name = "sandbox_config")
public class SandboxConfig {

    @Id
    private Long id = 1L;

    /** local-pyodide | private-docker | cloud-e2b */
    private String mode = "local-pyodide";

    private String dockerEndpoint = "unix:///var/run/docker.sock";

    private double cpuQuota = 1.0;        // CPU cores
    private int memoryQuotaMb = 512;      // MB
    private int timeoutSeconds = 120;     // hard kill timeout
    private boolean networkIsolation = true;

    public SandboxConfig() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getMode() { return mode; }
    public void setMode(String mode) { this.mode = mode; }

    public String getDockerEndpoint() { return dockerEndpoint; }
    public void setDockerEndpoint(String dockerEndpoint) { this.dockerEndpoint = dockerEndpoint; }

    public double getCpuQuota() { return cpuQuota; }
    public void setCpuQuota(double cpuQuota) { this.cpuQuota = cpuQuota; }

    public int getMemoryQuotaMb() { return memoryQuotaMb; }
    public void setMemoryQuotaMb(int memoryQuotaMb) { this.memoryQuotaMb = memoryQuotaMb; }

    public int getTimeoutSeconds() { return timeoutSeconds; }
    public void setTimeoutSeconds(int timeoutSeconds) { this.timeoutSeconds = timeoutSeconds; }

    public boolean isNetworkIsolation() { return networkIsolation; }
    public void setNetworkIsolation(boolean networkIsolation) { this.networkIsolation = networkIsolation; }
}
