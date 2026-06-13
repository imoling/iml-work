package com.imlwork.admin.controller;

import com.imlwork.admin.model.SyncFile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/sync")
public class SyncController {

    private final List<SyncFile> syncedFiles = new ArrayList<>();

    public SyncController() {
        // Seed some mock synchronized employee client files
        syncedFiles.add(new SyncFile("2026_q2_sales_plan.pdf", "/documents/2026_q2_sales_plan.pdf", "Q2销售规划，目标拓展北方市场客户", true, 1024500L, "张经理 (销售部)"));
        syncedFiles.add(new SyncFile("client_list_north.xlsx", "/documents/client_list_north.xlsx", "北方大区重点意向客户拜访名单与预算", true, 45200L, "张经理 (销售部)"));
    }

    @GetMapping("/files")
    public ResponseEntity<List<SyncFile>> getSyncedFiles() {
        return ResponseEntity.ok(syncedFiles);
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> uploadSyncFile(
            @RequestParam("file") MultipartFile file,
            @RequestParam("path") String path,
            @RequestParam("summary") String summary,
            @RequestParam("employee") String employee) {
        
        SyncFile newFile = new SyncFile(
                file.getOriginalFilename(),
                path,
                summary,
                true,
                file.getSize(),
                employee
        );
        syncedFiles.add(newFile);

        return ResponseEntity.ok(Map.of(
                "success", true,
                "filename", file.getOriginalFilename(),
                "status", "synced_and_archived"
        ));
    }
}
