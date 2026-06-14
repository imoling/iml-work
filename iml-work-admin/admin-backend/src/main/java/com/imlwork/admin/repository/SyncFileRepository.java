package com.imlwork.admin.repository;

import com.imlwork.admin.model.SyncFile;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SyncFileRepository extends JpaRepository<SyncFile, Long> {
}
