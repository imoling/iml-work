package com.imlwork.admin.controller;

import com.imlwork.admin.model.SyncFile;
import com.imlwork.admin.repository.SyncFileRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/sync")
public class SyncController {

    private final SyncFileRepository syncFileRepository;

    public SyncController(SyncFileRepository syncFileRepository) {
        this.syncFileRepository = syncFileRepository;
    }

    @GetMapping("/files")
    public ResponseEntity<List<SyncFile>> getSyncedFiles(
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "200") int size) {
        // 同步文件随每次上传增长：按创建时间倒序取一页 + 上限兜底，不再 findAll 全量返回。
        int capped = Math.max(1, Math.min(size, 1000));
        return ResponseEntity.ok(syncFileRepository
                .findAll(PageRequest.of(Math.max(0, page), capped, Sort.by(Sort.Direction.DESC, "createdAt")))
                .getContent());
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> uploadSyncFile(
            @RequestParam("file") MultipartFile file,
            @RequestParam("path") String path,
            @RequestParam("summary") String summary,
            @RequestParam("employee") String employee) {

        SyncFile newFile = new SyncFile(
                file.getOriginalFilename(), path, summary, true, file.getSize(), employee);
        syncFileRepository.save(newFile);

        return ResponseEntity.ok(Map.of(
                "success", true,
                "filename", file.getOriginalFilename(),
                "status", "synced_and_archived"
        ));
    }
}
