package com.imlwork.admin.repository;

import com.imlwork.admin.model.FdeBlueprint;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface FdeBlueprintRepository extends JpaRepository<FdeBlueprint, String> {

    List<FdeBlueprint> findByScenarioIdOrderByUpdatedAtDesc(String scenarioId);
}
