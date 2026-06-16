package com.imlwork.admin.controller;

import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 提供「FDE 工作台」(iml-fde-studio) 的下载。它是一个独立的瘦客户端技能构建工具，
 * 在本地登录目标业务系统操作一遍即可录制可回放的技能并上传回本技能中心。
 * 这里直接把工具源码打包为 zip（排除 node_modules/.git），内网用户下载后 npm install && npm start 即可使用。
 */
@RestController
@RequestMapping("/api/v1/tools/recorder")
public class ToolsController {

    private Path locateRecorderDir() {
        String env = System.getenv("IML_RECORDER_DIR");
        Path userDir = Paths.get(System.getProperty("user.dir"));
        Path[] candidates = new Path[]{
                env != null && !env.isBlank() ? Paths.get(env) : null,
                userDir.getParent() != null && userDir.getParent().getParent() != null
                        ? userDir.getParent().getParent().resolve("iml-fde-studio") : null,
                userDir.getParent() != null ? userDir.getParent().resolve("iml-fde-studio") : null,
                userDir.resolve("iml-fde-studio")
        };
        for (Path p : candidates) {
            if (p != null && Files.isDirectory(p) && Files.exists(p.resolve("package.json"))) return p;
        }
        return null;
    }

    @GetMapping("/info")
    public ResponseEntity<Map<String, Object>> info() {
        Path dir = locateRecorderDir();
        Map<String, Object> m = new HashMap<>();
        m.put("available", dir != null);
        m.put("name", "iML Work · FDE 工作台");
        m.put("howto", "下载解压后，在工具目录执行 npm install && npm start 即可运行；录制后技能会自动上传回本技能中心。");
        return ResponseEntity.ok(m);
    }

    @GetMapping("/download")
    public ResponseEntity<Resource> download() throws IOException {
        Path dir = locateRecorderDir();
        if (dir == null) {
            return ResponseEntity.status(404).build();
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bos)) {
            Files.walkFileTree(dir, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path d, BasicFileAttributes attrs) {
                    String n = d.getFileName().toString();
                    if (n.equals("node_modules") || n.equals(".git") || n.equals("dist") || n.equals("out")) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    String rel = "iml-fde-studio/" + dir.relativize(file).toString().replace('\\', '/');
                    zip.putNextEntry(new ZipEntry(rel));
                    Files.copy(file, zip);
                    zip.closeEntry();
                    return FileVisitResult.CONTINUE;
                }
            });
        }
        ByteArrayResource res = new ByteArrayResource(bos.toByteArray());
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"iml-fde-studio.zip\"")
                .contentType(MediaType.parseMediaType("application/zip"))
                .contentLength(res.contentLength())
                .body(res);
    }
}
