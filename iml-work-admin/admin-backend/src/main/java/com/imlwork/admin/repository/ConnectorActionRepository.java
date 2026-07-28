package com.imlwork.admin.repository;

import com.imlwork.admin.model.ConnectorAction;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ConnectorActionRepository extends JpaRepository<ConnectorAction, String> {

    // 过滤路径同样封顶（体检 P3-2：曾未封顶，随录制持续增长会越来越重）
    List<ConnectorAction> findTop500BySystemIdOrderByUpdatedAtDesc(String systemId);

    List<ConnectorAction> findTop500ByConnectionIdOrderByUpdatedAtDesc(String connectionId);

    // 全量目录封顶一页：连接器动作随录制/SOP 登记持续增长，列表只看最近维护的
    List<ConnectorAction> findTop500ByOrderByUpdatedAtDesc();

    /** 瘦身目录（浏览/绑定下拉用）：六个大 TEXT 列不出库（体检 P3-2；先例 /skills/catalog）。 */
    @org.springframework.data.jpa.repository.Query("select new com.imlwork.admin.dto.ConnectorActionBrief("
            + "c.id, c.systemId, c.connectionId, c.name, c.actionKey, c.capability, c.kind, c.version, c.updatedAt) "
            + "from ConnectorAction c order by c.updatedAt desc limit 500")
    List<com.imlwork.admin.dto.ConnectorActionBrief> findCatalog();
}
