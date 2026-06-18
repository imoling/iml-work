package com.imlwork.admin.repository;

import com.imlwork.admin.model.FdeTestRun;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface FdeTestRunRepository extends JpaRepository<FdeTestRun, String> {

    List<FdeTestRun> findByScenarioIdOrderByStartedAtDesc(String scenarioId);
}
