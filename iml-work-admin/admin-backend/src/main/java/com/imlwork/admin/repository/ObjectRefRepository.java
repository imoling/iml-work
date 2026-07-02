package com.imlwork.admin.repository;

import com.imlwork.admin.model.ObjectRef;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ObjectRefRepository extends JpaRepository<ObjectRef, String> {
    List<ObjectRef> findAllByOrderByLastSeenAtDesc();
    List<ObjectRef> findByObjectTypeOrderByLastSeenAtDesc(String objectType);
    ObjectRef findBySystemIdAndExternalId(String systemId, String externalId);
}
