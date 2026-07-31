package com.imlwork.admin.controller;

import com.imlwork.admin.service.ResourceCenterService;
import com.imlwork.admin.service.ResourceCenterService.ResourceFile;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

/** 资源中心（管理端）：语音模型等平台托管资源的清单/上传/删除。权限见 SecurityConfig（ENTERPRISE_MANAGE）。 */
@RestController
@RequestMapping("/api/v1/resources/stt-models")
public class ResourceCenterController {

    private final ResourceCenterService resourceCenterService;

    public ResourceCenterController(ResourceCenterService resourceCenterService) {
        this.resourceCenterService = resourceCenterService;
    }

    @GetMapping
    public List<ResourceFile> list() {
        return resourceCenterService.list();
    }

    /** 资源目录（按模型版本为单位）：状态 + 配置要求 + 拉取进度。管理端唯一消费入口。 */
    @GetMapping("/catalog")
    public List<ResourceCenterService.ModelStatus> catalog() {
        return resourceCenterService.catalog();
    }

    /** 服务端从公网镜像拉取整套模型（后台执行）。 */
    @PostMapping("/fetch")
    public void fetch(@RequestParam("model") String model) {
        resourceCenterService.fetchModel(model);
    }

    /** 删除整个模型版本。 */
    @DeleteMapping("/model")
    public void deleteModel(@RequestParam("model") String model) {
        resourceCenterService.deleteModel(model);
    }

    @PostMapping
    public ResourceFile upload(@RequestParam("file") MultipartFile file,
                               @RequestParam(value = "dir", required = false) String dir) {
        return resourceCenterService.upload(file, dir);
    }

    @DeleteMapping
    public void delete(@RequestParam("path") String path) {
        resourceCenterService.delete(path);
    }
}
