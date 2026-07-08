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

    public ClientNodeService(ClientNodeRepository repository) {
        this.repository = repository;
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
