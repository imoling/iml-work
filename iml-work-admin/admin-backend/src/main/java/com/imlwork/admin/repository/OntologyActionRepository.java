package com.imlwork.admin.repository;

import com.imlwork.admin.model.OntologyAction;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface OntologyActionRepository extends JpaRepository<OntologyAction, String> {
    List<OntologyAction> findAllByOrderByDomainAscObjectTypeAsc();
    List<OntologyAction> findByDomainOrderByObjectTypeAsc(String domain);
    List<OntologyAction> findByObjectTypeOrderByActionKeyAsc(String objectType);
}
