package com.imlwork.admin.repository;

import com.imlwork.admin.model.BusinessEvent;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface BusinessEventRepository extends JpaRepository<BusinessEvent, String> {
    List<BusinessEvent> findTop200ByOrderByCreatedAtDesc();
    List<BusinessEvent> findByObjectRefIdOrderByCreatedAtDesc(String objectRefId);
}
