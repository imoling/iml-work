package com.imlwork.admin.repository;

import com.imlwork.admin.model.OntologyType;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface OntologyTypeRepository extends JpaRepository<OntologyType, String> {
    List<OntologyType> findAllByOrderByDomainAscLabelAsc();
    List<OntologyType> findByDomainOrderByLabelAsc(String domain);
    OntologyType findByDomainAndTypeKey(String domain, String typeKey);
}
