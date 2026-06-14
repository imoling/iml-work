package com.imlwork.admin.repository;

import com.imlwork.admin.model.Expert;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ExpertRepository extends JpaRepository<Expert, String> {
}
