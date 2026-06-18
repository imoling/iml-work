package com.imlwork.admin.repository;

import com.imlwork.admin.model.FdeProject;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface FdeProjectRepository extends JpaRepository<FdeProject, String> {

    List<FdeProject> findAllByOrderByUpdatedAtDesc();
}
