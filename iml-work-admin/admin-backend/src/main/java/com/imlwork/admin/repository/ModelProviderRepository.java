package com.imlwork.admin.repository;

import com.imlwork.admin.model.ModelProvider;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ModelProviderRepository extends JpaRepository<ModelProvider, String> {
    List<ModelProvider> findByEnabledTrue();
}
