package com.imlwork.admin.repository;

import com.imlwork.admin.model.Role;
import org.springframework.data.jpa.repository.JpaRepository;

public interface RoleRepository extends JpaRepository<Role, String> {
}
