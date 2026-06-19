package com.imlwork.admin.repository;

import com.imlwork.admin.model.ConnectorAction;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ConnectorActionRepository extends JpaRepository<ConnectorAction, String> {

    List<ConnectorAction> findBySystemIdOrderByUpdatedAtDesc(String systemId);

    List<ConnectorAction> findByConnectionIdOrderByUpdatedAtDesc(String connectionId);

    List<ConnectorAction> findAllByOrderByUpdatedAtDesc();
}
