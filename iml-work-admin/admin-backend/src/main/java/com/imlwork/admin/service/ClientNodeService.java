package com.imlwork.admin.service;

import com.imlwork.admin.model.ClientNode;
import com.imlwork.admin.repository.ClientNodeRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Electron 客户端节点心跳与在线状态。最后心跳在 {@link #ONLINE_WINDOW_SECONDS} 秒内视为在线。
 * 业务与事务在此，控制器只做 HTTP 塑形。
 */
@Service
public class ClientNodeService {

    private static final long ONLINE_WINDOW_SECONDS = 90;

    private final ClientNodeRepository repository;

    // 客户端「检测更新」真相源：nginx /downloads/ 的安装包清单（gen-download-manifest.sh 产物）。
    // 后端与 nginx 同机（服务器 host 网络部署），默认 127.0.0.1 即达；分体部署时外置配置覆盖。
    @org.springframework.beans.factory.annotation.Value("${client.downloads.manifest-url:http://127.0.0.1/downloads/manifest.json}")
    private String manifestUrl;

    /** 下载落地页（客户端「前往下载页」跳转）；空则由客户端按部署约定推导。 */
    @org.springframework.beans.factory.annotation.Value("${client.downloads.page-url:}")
    private String pageUrl;

    private final java.net.http.HttpClient http = java.net.http.HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();
    private final com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();

    public ClientNodeService(ClientNodeRepository repository) {
        this.repository = repository;
    }

    /** 客户端「检测更新」：转发安装包清单。未发布/不可达 → available=false 如实返回，绝不编版本号。 */
    public Map<String, Object> updateManifest() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("pageUrl", pageUrl == null ? "" : pageUrl);
        try {
            java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder(java.net.URI.create(manifestUrl))
                    .timeout(Duration.ofSeconds(5)).GET().build();
            java.net.http.HttpResponse<String> res = http.send(req, java.net.http.HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() / 100 != 2) throw new IllegalStateException("HTTP " + res.statusCode());
            com.fasterxml.jackson.databind.JsonNode d = mapper.readTree(res.body());
            out.put("available", true);
            out.put("version", d.path("version").asText(""));
            out.put("updatedAt", d.path("updatedAt").asText(""));
            out.put("files", mapper.convertValue(d.path("files"), List.class));
        } catch (Exception e) {
            out.put("available", false);
            out.put("error", "服务器未发布安装包清单");
        }
        return out;
    }

    /** 清理离线节点：删除超出在线窗口未心跳的节点（陈旧测试节点堆积清场）。返回删除数。
     *  在线节点不动；被删的节点若客户端重连会经心跳重新注册，非破坏性。 */
    @Transactional
    public int pruneOffline() {
        LocalDateTime cutoff = LocalDateTime.now().minusSeconds(ONLINE_WINDOW_SECONDS);
        List<ClientNode> stale = repository.findAll().stream()
                .filter(n -> n.getLastSeen() == null || n.getLastSeen().isBefore(cutoff))
                .toList();
        repository.deleteAll(stale);
        return stale.size();
    }

    /** upsert 一次心跳，返回节点 clientId。 */
    @Transactional
    public String upsertHeartbeat(ClientNode incoming) {
        ClientNode node = repository.findById(incoming.getClientId()).orElseGet(ClientNode::new);
        node.setClientId(incoming.getClientId());
        node.setHostname(incoming.getHostname());
        node.setExpertId(incoming.getExpertId());
        node.setExpertName(incoming.getExpertName());
        node.setSandboxMode(incoming.getSandboxMode());
        node.setPyodideHealthy(incoming.isPyodideHealthy());
        node.setImCommandCount(incoming.getImCommandCount());
        node.setAppVersion(incoming.getAppVersion());
        node.setLastSeen(LocalDateTime.now());
        repository.save(node);
        return node.getClientId();
    }

    /** 全部节点 + 在线判定（供管理端 SandboxManager 展示）。 */
    @Transactional(readOnly = true)
    public List<Map<String, Object>> listWithStatus() {
        LocalDateTime now = LocalDateTime.now();
        return repository.findAll().stream().map(n -> {
            boolean online = n.getLastSeen() != null
                    && Duration.between(n.getLastSeen(), now).getSeconds() <= ONLINE_WINDOW_SECONDS;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("clientId", n.getClientId());
            m.put("hostname", n.getHostname());
            m.put("expertId", n.getExpertId());
            m.put("expertName", n.getExpertName());
            m.put("sandboxMode", n.getSandboxMode());
            m.put("pyodideHealthy", n.isPyodideHealthy());
            m.put("imCommandCount", n.getImCommandCount());
            m.put("appVersion", n.getAppVersion());
            m.put("lastSeen", n.getLastSeen());
            m.put("online", online);
            return m;
        }).toList();
    }
}
