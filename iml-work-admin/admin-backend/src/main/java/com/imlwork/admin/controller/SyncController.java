package com.imlwork.admin.controller;

import com.imlwork.admin.model.SyncFile;
import com.imlwork.admin.service.SyncFileService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/sync")
public class SyncController {

    private final SyncFileService syncFileService;

    public SyncController(SyncFileService syncFileService) {
        this.syncFileService = syncFileService;
    }

    @GetMapping("/files")
    public ResponseEntity<List<SyncFile>> getSyncedFiles(
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "200") int size) {
        return ResponseEntity.ok(syncFileService.listRecent(page, size));
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> uploadSyncFile(
            @RequestParam("file") MultipartFile file,
            @RequestParam("path") String path,
            @RequestParam("summary") String summary,
            @RequestParam("employee") String employee) {

        syncFileService.archive(file.getOriginalFilename(), path, summary, file.getSize(), employee);

        return ResponseEntity.ok(Map.of(
                "success", true,
                "filename", file.getOriginalFilename(),
                "status", "synced_and_archived"
        ));
    }
}
