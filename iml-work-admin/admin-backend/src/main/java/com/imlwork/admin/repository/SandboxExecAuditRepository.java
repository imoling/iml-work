package com.imlwork.admin.repository;

import com.imlwork.admin.model.SandboxExecAudit;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

import java.util.List;

public interface SandboxExecAuditRepository extends JpaRepository<SandboxExecAudit, Long> {

    List<SandboxExecAudit> findAllByOrderByCreatedAtDesc(Pageable pageable);

    /** 保留上限：删除超出最近 keep 条之外的旧记录（防审计表无界增长）。 */
    @Modifying
    @Query(value = "DELETE FROM sandbox_exec_audit WHERE id NOT IN "
            + "(SELECT id FROM sandbox_exec_audit ORDER BY id DESC LIMIT :keep)", nativeQuery = true)
    void pruneKeepLatest(long keep);
}
