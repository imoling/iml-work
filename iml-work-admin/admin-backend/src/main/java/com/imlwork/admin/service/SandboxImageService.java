package com.imlwork.admin.service;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
import com.github.dockerjava.httpclient5.ApacheDockerHttpClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

/**
 * 沙箱镜像托管（资源中心）：把服务器 Docker 里的沙箱基础镜像导出成 tar 托管，
 * 供客户端「本地沙箱」下载后 docker load——本地/云端同一镜像，执行语义 100% 同构。
 * 导出是后台任务（镜像几百 MB，docker save 要跑一会），管理端轮询 info 看进度。
 */
@Service
public class SandboxImageService {

    public record ImageInfo(boolean ready, String fileName, long sizeBytes, long updatedAt,
                            String imageTag, boolean exporting, String exportError) {}

    @Value("${iml.sandbox-image-dir:./resources/sandbox-image}")
    private String imageDir;

    private final SandboxConfigService sandboxConfigService;

    private volatile boolean exporting = false;
    private volatile String exportError = null;

    public SandboxImageService(SandboxConfigService sandboxConfigService) {
        this.sandboxConfigService = sandboxConfigService;
    }

    private String imageTag() {
        var cfg = sandboxConfigService.getOrCreate();
        String img = cfg.getBaseImage();
        return (img == null || img.isBlank()) ? "iml-sandbox:py312" : img.trim();
    }

    /** tar 文件名按镜像 tag 规整（冒号/斜杠不能进文件名）。 */
    private Path tarPath() {
        String name = imageTag().replace('/', '_').replace(':', '-') + ".tar";
        return Path.of(imageDir).toAbsolutePath().normalize().resolve(name);
    }

    public ImageInfo info() {
        Path p = tarPath();
        boolean ready = Files.isRegularFile(p);
        long size = 0;
        long at = 0;
        if (ready) {
            try { size = Files.size(p); at = Files.getLastModifiedTime(p).toMillis(); } catch (IOException ignored) { }
        }
        return new ImageInfo(ready, p.getFileName().toString(), size, at, imageTag(), exporting, exportError);
    }

    public Path fileForDownload() {
        Path p = tarPath();
        if (!Files.isRegularFile(p)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "沙箱镜像尚未导出托管，请联系管理员在资源中心导出");
        }
        return p;
    }

    /** 后台导出：docker save → 临时文件 → 原子改名（下载端永远只见完整文件）。 */
    public synchronized void export() {
        if (exporting) throw new IllegalArgumentException("镜像正在导出中");
        exporting = true;
        exportError = null;
        Thread.startVirtualThread(this::doExport);
    }

    private void doExport() {
        String tag = imageTag();
        Path target = tarPath();
        Path tmp = target.resolveSibling(target.getFileName() + ".part");
        try (DockerClient d = client(sandboxConfigService.getOrCreate().getDockerEndpoint())) {
            Files.createDirectories(target.getParent());
            try (InputStream in = d.saveImageCmd(tag).exec()) {
                Files.copy(in, tmp, StandardCopyOption.REPLACE_EXISTING);
            }
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception e) {
            exportError = "导出失败：" + e.getMessage() + "——确认服务器 Docker 可达且镜像 " + tag + " 存在";
            try { Files.deleteIfExists(tmp); } catch (IOException ignored) { }
        } finally {
            exporting = false;
        }
    }

    /** 与 SandboxExecService 同款的 docker 客户端构建（端点来自沙箱配置）。 */
    private DockerClient client(String endpoint) {
        String host = (endpoint == null || endpoint.isBlank()) ? "unix:///var/run/docker.sock" : endpoint.trim();
        var cfg = DefaultDockerClientConfig.createDefaultConfigBuilder().withDockerHost(host).build();
        var http = new ApacheDockerHttpClient.Builder()
                .dockerHost(cfg.getDockerHost())
                .connectionTimeout(Duration.ofSeconds(10))
                .responseTimeout(Duration.ofMinutes(10))
                .build();
        return DockerClientImpl.getInstance(cfg, http);
    }
}
