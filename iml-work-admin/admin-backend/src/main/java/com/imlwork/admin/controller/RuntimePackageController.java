package com.imlwork.admin.controller;

import com.imlwork.admin.service.ResourceCenterService;
import com.imlwork.admin.service.ResourceCenterService.ResourceFile;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.nio.file.Path;
import java.util.List;

/**
 * 运行时安装包（Docker 运行时 dmg 等，本地沙箱前置组件）：
 * 列表/下载对公开下载页开放（permitAll——公开软件安装包无敏感信息，员工未登录也能从下载页获取）；
 * 上传/删除归管理端（ENTERPRISE_MANAGE，见 SecurityConfig）。
 */
@RestController
@RequestMapping("/api/v1/resources/runtime-packages")
public class RuntimePackageController {

    private final ResourceCenterService resourceCenterService;

    public RuntimePackageController(ResourceCenterService resourceCenterService) {
        this.resourceCenterService = resourceCenterService;
    }

    @GetMapping
    public List<ResourceFile> list() {
        return resourceCenterService.listRuntimePackages();
    }

    @GetMapping("/download")
    public ResponseEntity<FileSystemResource> download(@RequestParam("name") String name) {
        Path p = resourceCenterService.runtimePackageFile(name);
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + p.getFileName() + "\"")
                .body(new FileSystemResource(p));
    }

    @PostMapping
    public ResourceFile upload(@RequestParam("file") MultipartFile file) {
        return resourceCenterService.uploadRuntimePackage(file);
    }

    @DeleteMapping
    public void delete(@RequestParam("name") String name) {
        resourceCenterService.deleteRuntimePackage(name);
    }
}
