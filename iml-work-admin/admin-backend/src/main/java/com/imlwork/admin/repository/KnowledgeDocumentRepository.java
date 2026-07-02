package com.imlwork.admin.repository;

import com.imlwork.admin.model.KnowledgeDocument;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface KnowledgeDocumentRepository extends JpaRepository<KnowledgeDocument, String> {

    List<KnowledgeDocument> findByScope(String scope);

    List<KnowledgeDocument> findByScopeAndOwnerId(String scope, String ownerId);

    List<KnowledgeDocument> findByPromotionStatus(String promotionStatus);
}
