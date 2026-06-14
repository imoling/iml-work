package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * An external enterprise business system the agents drive (OA / CRM / EMAIL /
 * GITHUB ...). Holds connection endpoint, credentials and a simple connection
 * state machine toggled by credential verification.
 */
@Entity
@Table(name = "system_integration")
public class SystemIntegration {

    @Id
    private String id;

    /** OA | CRM | EMAIL | GITHUB | ERP | OTHER */
    private String type;

    private String name;
    private String baseUrl;
    private String username;

    @Column(length = 1000)
    private String secret;

    /** DISCONNECTED | CONNECTED | ERROR */
    private String status = "DISCONNECTED";

    @Column(length = 1000)
    private String message;

    private LocalDateTime lastChecked;

    public SystemIntegration() {}

    public SystemIntegration(String id, String type, String name, String baseUrl, String username, String secret) {
        this.id = id;
        this.type = type;
        this.name = name;
        this.baseUrl = baseUrl;
        this.username = username;
        this.secret = secret;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getSecret() { return secret; }
    public void setSecret(String secret) { this.secret = secret; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }

    public LocalDateTime getLastChecked() { return lastChecked; }
    public void setLastChecked(LocalDateTime lastChecked) { this.lastChecked = lastChecked; }
}
