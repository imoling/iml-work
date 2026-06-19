package com.imlwork.admin.repository;

import com.imlwork.admin.model.SystemConnection;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface SystemConnectionRepository extends JpaRepository<SystemConnection, String> {

    List<SystemConnection> findBySystemIdOrderByUpdatedAtDesc(String systemId);

    List<SystemConnection> findByOwnerUserIdOrderByUpdatedAtDesc(String ownerUserId);

    List<SystemConnection> findAllByOrderByUpdatedAtDesc();
}
