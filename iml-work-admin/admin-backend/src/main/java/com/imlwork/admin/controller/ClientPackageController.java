package com.imlwork.admin.controller;

import com.imlwork.admin.service.ResourceCenterService;
import com.imlwork.admin.service.ResourceCenterService.ClientPackage;
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
 * 客户端安装包（平台托管 + 版本管理）：列表/下载对公开下载页开放（permitAll），
 * 上传/删除归管理端（ENTERPRISE_MANAGE，见 SecurityConfig）。
 */
@RestController
@RequestMapping("/api/v1/resources/client-packages")
public class ClientPackageController {

    private final ResourceCenterService resourceCenterService;

    public ClientPackageController(ResourceCenterService resourceCenterService) {
        this.resourceCenterService = resourceCenterService;
    }

    @GetMapping
    public List<ClientPackage> list() {
        return resourceCenterService.listClientPackages();
    }

    @GetMapping("/download")
    public ResponseEntity<FileSystemResource> download(@RequestParam("name") String name) {
        Path p = resourceCenterService.clientPackageFile(name);
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + p.getFileName() + "\"")
                .body(new FileSystemResource(p));
    }

    @PostMapping
    public ClientPackage upload(@RequestParam("file") MultipartFile file,
                                @RequestParam("product") String product,
                                @RequestParam("version") String version,
                                @RequestParam(value = "platform", required = false) String platform,
                                @RequestParam(value = "arch", required = false) String arch) {
        return resourceCenterService.uploadClientPackage(file, product, version, platform, arch);
    }

    @DeleteMapping
    public void delete(@RequestParam("name") String name) {
        resourceCenterService.deleteClientPackage(name);
    }
}
