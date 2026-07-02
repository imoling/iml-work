package com.imlwork.admin.repository;

import com.imlwork.admin.model.PasswordResetRequest;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface PasswordResetRequestRepository extends JpaRepository<PasswordResetRequest, String> {
    List<PasswordResetRequest> findByStatusOrderByCreatedAtDesc(String status);
    List<PasswordResetRequest> findByUserIdAndStatus(String userId, String status);
}
