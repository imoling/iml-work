package com.imlwork.admin.repository;

import com.imlwork.admin.model.ConnectorAction;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ConnectorActionRepository extends JpaRepository<ConnectorAction, String> {

    List<ConnectorAction> findBySystemIdOrderByUpdatedAtDesc(String systemId);

    List<ConnectorAction> findByConnectionIdOrderByUpdatedAtDesc(String connectionId);

    // 全量目录封顶一页：连接器动作随录制/SOP 登记持续增长，列表只看最近维护的
    List<ConnectorAction> findTop500ByOrderByUpdatedAtDesc();
}
