package com.imlwork.admin.repository;

import com.imlwork.admin.model.BusinessEvent;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface BusinessEventRepository extends JpaRepository<BusinessEvent, String> {
    List<BusinessEvent> findTop200ByOrderByCreatedAtDesc();
    // 单对象时间线同样封顶：事件表随执行持续增长，审计视图只看最近一段
    List<BusinessEvent> findTop200ByObjectRefIdOrderByCreatedAtDesc(String objectRefId);
}
