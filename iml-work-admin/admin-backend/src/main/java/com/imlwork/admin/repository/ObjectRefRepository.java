package com.imlwork.admin.repository;

import com.imlwork.admin.model.ObjectRef;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ObjectRefRepository extends JpaRepository<ObjectRef, String> {
    // 封顶一页：对象引用随客户端执行动作持续增长，管理端审计只看最近活跃的
    List<ObjectRef> findTop500ByOrderByLastSeenAtDesc();
    List<ObjectRef> findTop500ByObjectTypeOrderByLastSeenAtDesc(String objectType);
    ObjectRef findBySystemIdAndExternalId(String systemId, String externalId);
}
