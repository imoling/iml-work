package com.imlwork.admin.repository;

import com.imlwork.admin.model.FdeScenario;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface FdeScenarioRepository extends JpaRepository<FdeScenario, String> {

    List<FdeScenario> findByProjectIdOrderByUpdatedAtDesc(String projectId);

    List<FdeScenario> findAllByOrderByUpdatedAtDesc();
}
