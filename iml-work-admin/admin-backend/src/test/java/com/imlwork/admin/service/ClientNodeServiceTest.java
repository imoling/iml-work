package com.imlwork.admin.service;

import com.imlwork.admin.model.ClientNode;
import com.imlwork.admin.repository.ClientNodeRepository;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** 客户端节点心跳 upsert 与在线窗口（90s）判定。 */
class ClientNodeServiceTest {

    private static ClientNode node(String id, LocalDateTime lastSeen) {
        ClientNode n = new ClientNode();
        n.setClientId(id);
        n.setLastSeen(lastSeen);
        return n;
    }

    @Test
    void heartbeat_upserts_andStampsLastSeen() {
        ClientNodeRepository repo = mock(ClientNodeRepository.class);
        when(repo.findById("c-1")).thenReturn(Optional.empty());
        ClientNodeService svc = new ClientNodeService(repo);

        ClientNode incoming = node("c-1", null);
        incoming.setHostname("mac-01");
        String id = svc.upsertHeartbeat(incoming);

        assertEquals("c-1", id);
        ArgumentCaptor<ClientNode> saved = ArgumentCaptor.forClass(ClientNode.class);
        verify(repo).save(saved.capture());
        assertEquals("mac-01", saved.getValue().getHostname());
        assertNotNull(saved.getValue().getLastSeen(), "心跳必须盖 lastSeen 时间戳");
    }

    @Test
    void list_marksOnlineWithin90s_offlineBeyond() {
        ClientNodeRepository repo = mock(ClientNodeRepository.class);
        when(repo.findAll()).thenReturn(List.of(
                node("fresh", LocalDateTime.now().minusSeconds(10)),
                node("stale", LocalDateTime.now().minusSeconds(300)),
                node("never", null)));
        ClientNodeService svc = new ClientNodeService(repo);

        List<Map<String, Object>> rows = svc.listWithStatus();

        assertEquals(Boolean.TRUE, rows.get(0).get("online"));
        assertEquals(Boolean.FALSE, rows.get(1).get("online"));
        assertEquals(Boolean.FALSE, rows.get(2).get("online"));
    }
}
