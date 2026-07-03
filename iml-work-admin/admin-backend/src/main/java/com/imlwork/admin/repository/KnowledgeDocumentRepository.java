package com.imlwork.admin.repository;

import com.imlwork.admin.model.KnowledgeDocument;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface KnowledgeDocumentRepository extends JpaRepository<KnowledgeDocument, String> {

    List<KnowledgeDocument> findByScope(String scope);

    List<KnowledgeDocument> findByScopeAndOwnerId(String scope, String ownerId);

    List<KnowledgeDocument> findByPromotionStatus(String promotionStatus);

    // 分页/上限版：文档列表随上传增长，避免 findAll 全量返回。
    List<KnowledgeDocument> findByScope(String scope, Pageable pageable);

    List<KnowledgeDocument> findByScopeAndOwnerId(String scope, String ownerId, Pageable pageable);
}
