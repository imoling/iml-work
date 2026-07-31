package com.imlwork.admin.controller;

import com.imlwork.admin.service.ResourceCenterService;
import com.imlwork.admin.service.SttModelService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;

/**
 * 语音模型文件下发（公开静态资源，无敏感信息）：客户端 transformers.js 的
 * remoteHost 指到 /api/v1/stt-models，按 HF 路径模板请求模型文件。
 * 客户端渲染层直接 fetch（不带 JWT），故 permitAll + 放开跨域。
 */
@RestController
@CrossOrigin(origins = "*")
public class SttModelController {

    private static final String PREFIX = "/api/v1/stt-models/";

    private final SttModelService sttModelService;
    private final ResourceCenterService resourceCenterService;

    public SttModelController(SttModelService sttModelService, ResourceCenterService resourceCenterService) {
        this.sttModelService = sttModelService;
        this.resourceCenterService = resourceCenterService;
    }

    /** 公开模型目录（客户端语音设置页消费）：全部版本 + 设备门槛 + 平台托管状态。 */
    @GetMapping(PREFIX + "catalog")
    public java.util.List<ResourceCenterService.PublicModel> catalog() {
        return resourceCenterService.publicCatalog();
    }

    @GetMapping(PREFIX + "**")
    public ResponseEntity<FileSystemResource> download(HttpServletRequest request) {
        String rel = request.getRequestURI().substring(request.getRequestURI().indexOf(PREFIX) + PREFIX.length());
        Path file = sttModelService.resolveFile(rel);
        MediaType type = rel.endsWith(".json")
                ? MediaType.APPLICATION_JSON
                : MediaType.APPLICATION_OCTET_STREAM;
        // FileSystemResource 自动带 Content-Length——客户端下载进度依赖它
        return ResponseEntity.ok().contentType(type).body(new FileSystemResource(file));
    }
}
