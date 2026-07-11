package com.imlwork.admin.repository;

import com.imlwork.admin.model.DictItem;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface DictItemRepository extends JpaRepository<DictItem, Long> {
    List<DictItem> findByTypeAndEnabledTrueOrderBySortOrderAscIdAsc(String type);
    List<DictItem> findAllByOrderByTypeAscSortOrderAscIdAsc();
    Optional<DictItem> findByTypeAndLabel(String type, String label);
}
