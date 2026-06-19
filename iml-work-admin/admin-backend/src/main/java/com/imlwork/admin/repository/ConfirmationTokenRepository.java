package com.imlwork.admin.repository;

import com.imlwork.admin.model.ConfirmationToken;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ConfirmationTokenRepository extends JpaRepository<ConfirmationToken, String> {

    List<ConfirmationToken> findByConnectionIdOrderByIssuedAtDesc(String connectionId);
}
