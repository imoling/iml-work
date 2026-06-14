package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * A client (Electron desktop) node reporting its sandbox runtime telemetry to
 * the admin console via periodic heartbeats. Powers the "online client nodes"
 * view in SandboxManager.
 */
@Entity
@Table(name = "client_node")
public class ClientNode {

    @Id
    private String clientId;

    private String hostname;
    private String expertId;
    private String expertName;

    /** Sandbox runtime mode reported by the client: local-pyodide / private-docker / cloud-e2b. */
    private String sandboxMode;
    private boolean pyodideHealthy;
    private int imCommandCount;
    private String appVersion;

    private LocalDateTime lastSeen;

    public ClientNode() {}

    public String getClientId() { return clientId; }
    public void setClientId(String clientId) { this.clientId = clientId; }

    public String getHostname() { return hostname; }
    public void setHostname(String hostname) { this.hostname = hostname; }

    public String getExpertId() { return expertId; }
    public void setExpertId(String expertId) { this.expertId = expertId; }

    public String getExpertName() { return expertName; }
    public void setExpertName(String expertName) { this.expertName = expertName; }

    public String getSandboxMode() { return sandboxMode; }
    public void setSandboxMode(String sandboxMode) { this.sandboxMode = sandboxMode; }

    public boolean isPyodideHealthy() { return pyodideHealthy; }
    public void setPyodideHealthy(boolean pyodideHealthy) { this.pyodideHealthy = pyodideHealthy; }

    public int getImCommandCount() { return imCommandCount; }
    public void setImCommandCount(int imCommandCount) { this.imCommandCount = imCommandCount; }

    public String getAppVersion() { return appVersion; }
    public void setAppVersion(String appVersion) { this.appVersion = appVersion; }

    public LocalDateTime getLastSeen() { return lastSeen; }
    public void setLastSeen(LocalDateTime lastSeen) { this.lastSeen = lastSeen; }
}
