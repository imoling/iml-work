package com.imlwork.admin.repository;

import com.imlwork.admin.model.FdeDeliveryPackage;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface FdeDeliveryPackageRepository extends JpaRepository<FdeDeliveryPackage, String> {

    List<FdeDeliveryPackage> findByScenarioIdOrderByUpdatedAtDesc(String scenarioId);
}
