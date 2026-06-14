package com.imlwork.admin.repository;

import com.imlwork.admin.model.KnowledgeDocument;
import org.springframework.data.jpa.repository.JpaRepository;

public interface KnowledgeDocumentRepository extends JpaRepository<KnowledgeDocument, String> {
}
