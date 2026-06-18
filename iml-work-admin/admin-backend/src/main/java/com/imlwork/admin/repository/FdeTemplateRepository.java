package com.imlwork.admin.repository;

import com.imlwork.admin.model.FdeTemplate;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface FdeTemplateRepository extends JpaRepository<FdeTemplate, String> {

    List<FdeTemplate> findAllByOrderByUpdatedAtDesc();

    List<FdeTemplate> findByType(String type);
}
