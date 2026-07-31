package com.imlwork.admin.controller;

import com.imlwork.admin.service.SandboxImageService;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;

/**
 * 沙箱镜像下发：info/download 员工客户端可用（登录即可，本地沙箱一键安装用）；
 * export 仅管理端（见 SecurityConfig：/export 需 ENTERPRISE_MANAGE）。
 */
@RestController
@RequestMapping("/api/v1/resources/sandbox-image")
public class SandboxImageController {

    private final SandboxImageService sandboxImageService;

    public SandboxImageController(SandboxImageService sandboxImageService) {
        this.sandboxImageService = sandboxImageService;
    }

    @GetMapping("/info")
    public SandboxImageService.ImageInfo info() {
        return sandboxImageService.info();
    }

    @GetMapping("/download")
    public ResponseEntity<FileSystemResource> download() {
        Path p = sandboxImageService.fileForDownload();
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + p.getFileName() + "\"")
                .body(new FileSystemResource(p));
    }

    @PostMapping("/export")
    public void export() {
        sandboxImageService.export();
    }
}
