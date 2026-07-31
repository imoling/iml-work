package com.imlwork.admin.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * 资源中心：平台托管的离线资源治理（当前为语音模型；客户端安装包走 nginx /downloads/ 既有体系；
 * 后续扩展本地沙箱镜像等）。文件放在 {iml.stt-models-dir}，目录结构与 HF 仓库一致，
 * 客户端经 /api/v1/stt-models/** 下载（见 SttModelService）。
 */
@Service
public class ResourceCenterService {

    /** 资源文件窄投影：列表只出路径/大小/时间，不读文件内容。 */
    public record ResourceFile(String path, long sizeBytes, long updatedAt) {}

    @Value("${iml.stt-models-dir:./models/stt}")
    private String modelsDir;

    private Path baseDir() {
        return Path.of(modelsDir).toAbsolutePath().normalize();
    }

    /** 目录内文件清单（相对路径，按路径排序）；目录不存在返回空表而非报错——尚未放置任何模型是常态。 */
    public List<ResourceFile> list() {
        Path base = baseDir();
        if (!Files.isDirectory(base)) return List.of();
        try (Stream<Path> s = Files.walk(base)) {
            return s.filter(Files::isRegularFile)
                    .map(f -> {
                        try {
                            return new ResourceFile(
                                    base.relativize(f).toString().replace('\\', '/'),
                                    Files.size(f),
                                    Files.getLastModifiedTime(f).toMillis());
                        } catch (IOException e) {
                            return null;
                        }
                    })
                    .filter(x -> x != null)
                    .sorted(Comparator.comparing(ResourceFile::path))
                    .toList();
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "读取资源目录失败: " + e.getMessage());
        }
    }

    /** 上传到 {dir}/{原始文件名}；同名覆盖（模型文件更新是常规操作）。 */
    public ResourceFile upload(MultipartFile file, String dir) {
        String name = Path.of(file.getOriginalFilename() == null ? "" : file.getOriginalFilename())
                .getFileName().toString();
        if (name.isBlank()) throw new IllegalArgumentException("文件名为空");
        Path target = resolveSafe((dir == null ? "" : dir.trim()) + "/" + name);
        try {
            Files.createDirectories(target.getParent());
            file.transferTo(target);
            return new ResourceFile(baseDir().relativize(target).toString().replace('\\', '/'),
                    Files.size(target), Files.getLastModifiedTime(target).toMillis());
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "保存失败: " + e.getMessage());
        }
    }

    public void delete(String path) {
        Path target = resolveSafe(path);
        try {
            if (!Files.deleteIfExists(target)) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "文件不存在: " + path);
            }
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "删除失败: " + e.getMessage());
        }
    }

    // ── 资源目录（按模型为单位，管理端不再暴露文件明细）───────────────────────────
    // 每个条目 = 一个可托管的模型版本：必备文件清单 + 客户端设备建议。新增版本改这里即可。

    public record ModelSpec(String id, String name, String desc, String approxSize,
                            String requirements, int minMemGb, int minCores, List<String> files) {}

    /** 客户端消费的公开目录投影（无内部拉取态）：repo = HF 仓库路径，hosted = 平台已齐全可下发。 */
    public record PublicModel(String id, String name, String desc, String approxSize,
                              String requirements, int minMemGb, int minCores, String repo, boolean hosted) {}

    /** 拉取进度（内存态，重启即清；running=false 且 error 空 = 空闲/已完成）。 */
    public record FetchState(boolean running, int done, int total, String currentFile, String error) {}

    public record ModelStatus(String id, String name, String desc, String approxSize, String requirements,
                              String status, long hostedBytes, FetchState fetch) {}

    private static final String MIRROR = "https://hf-mirror.com";

    private static List<String> hfFiles(String repo) {
        return List.of(
                repo + "/config.json",
                repo + "/generation_config.json",
                repo + "/preprocessor_config.json",
                repo + "/tokenizer.json",
                repo + "/tokenizer_config.json",
                repo + "/onnx/encoder_model_quantized.onnx",
                repo + "/onnx/decoder_model_merged_quantized.onnx");
    }

    private static final List<ModelSpec> CATALOG = List.of(
            new ModelSpec("whisper-tiny", "Whisper Tiny · 多语言", "最快最省，转写精度一般——低配设备兜底",
                    "约 30MB", "4GB 内存 · 2 核", 4, 2, hfFiles("onnx-community/whisper-tiny")),
            new ModelSpec("whisper-base", "Whisper Base · 多语言", "速度与精度均衡——客户端语音输入默认模型",
                    "约 57MB", "8GB 内存 · 4 核", 8, 4, hfFiles("onnx-community/whisper-base")),
            // small 用 q4 清单（decoder q8 体积近 150MB，q4 精度损失可接受且平台已托管）。
            // 注意：客户端引擎锁 transformers.js v3——v4 捆绑的 ORT 1.26-dev 对 whisper 全系量化建会话即崩（2026-08-01 实锤）。
            new ModelSpec("whisper-small", "Whisper Small · 多语言", "精度更高，转写更慢——高配设备可选",
                    "约 285MB", "16GB 内存 · 8 核", 16, 8, List.of(
                    "onnx-community/whisper-small/config.json",
                    "onnx-community/whisper-small/generation_config.json",
                    "onnx-community/whisper-small/preprocessor_config.json",
                    "onnx-community/whisper-small/tokenizer.json",
                    "onnx-community/whisper-small/tokenizer_config.json",
                    "onnx-community/whisper-small/onnx/encoder_model_q4.onnx",
                    "onnx-community/whisper-small/onnx/decoder_model_merged_q4.onnx")));

    private final java.util.concurrent.ConcurrentHashMap<String, FetchState> fetchStates = new java.util.concurrent.ConcurrentHashMap<>();

    /** 资源目录 + 各版本托管状态（ready 齐全 / partial 不完整 / absent 未托管）。 */
    public List<ModelStatus> catalog() {
        Path base = baseDir();
        return CATALOG.stream().map(m -> {
            long bytes = 0;
            int present = 0;
            for (String f : m.files()) {
                Path p = base.resolve(f);
                if (Files.isRegularFile(p)) {
                    present++;
                    try { bytes += Files.size(p); } catch (IOException e) { /* 大小缺失不影响状态判定 */ }
                }
            }
            String status = present == m.files().size() ? "ready" : present == 0 ? "absent" : "partial";
            return new ModelStatus(m.id(), m.name(), m.desc(), m.approxSize(), m.requirements(),
                    status, bytes, fetchStates.get(m.id()));
        }).toList();
    }

    /** 客户端可见的公开目录：全部版本 + 平台托管状态（客户端据此展示选择与推荐）。 */
    public List<PublicModel> publicCatalog() {
        Path base = baseDir();
        return CATALOG.stream().map(m -> {
            boolean hosted = m.files().stream().allMatch(f -> Files.isRegularFile(base.resolve(f)));
            String[] seg = m.files().get(0).split("/", 3);
            return new PublicModel(m.id(), m.name(), m.desc(), m.approxSize(), m.requirements(),
                    m.minMemGb(), m.minCores(), seg[0] + "/" + seg[1], hosted);
        }).toList();
    }

    /** 服务端从公网镜像拉取整套模型文件（后台执行，管理端轮询 catalog 看进度）。 */
    public void fetchModel(String id) {
        ModelSpec spec = CATALOG.stream().filter(m -> m.id().equals(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("未知模型: " + id));
        FetchState cur = fetchStates.get(id);
        if (cur != null && cur.running()) throw new IllegalArgumentException("该模型正在拉取中");
        fetchStates.put(id, new FetchState(true, 0, spec.files().size(), "", null));
        Thread.startVirtualThread(() -> doFetch(spec));
    }

    private void doFetch(ModelSpec spec) {
        Path base = baseDir();
        java.net.http.HttpClient client = java.net.http.HttpClient.newBuilder()
                .followRedirects(java.net.http.HttpClient.Redirect.NORMAL)
                .connectTimeout(java.time.Duration.ofSeconds(20)).build();
        int done = 0;
        for (String f : spec.files()) {
            Path target = base.resolve(f);
            fetchStates.put(spec.id(), new FetchState(true, done, spec.files().size(), f, null));
            try {
                if (!Files.isRegularFile(target)) {   // 已有的文件不重下（断点续拉整体幂等）
                    Files.createDirectories(target.getParent());
                    // HF 的 resolve 路径：{repo}/resolve/main/{file}，repo 是路径前两段
                    String[] seg = f.split("/", 3);
                    String url = MIRROR + "/" + seg[0] + "/" + seg[1] + "/resolve/main/" + seg[2];
                    var res = client.send(
                            java.net.http.HttpRequest.newBuilder(java.net.URI.create(url)).build(),
                            java.net.http.HttpResponse.BodyHandlers.ofFile(target));
                    if (res.statusCode() != 200) {
                        Files.deleteIfExists(target);
                        throw new IOException("HTTP " + res.statusCode());
                    }
                }
                done++;
            } catch (Exception e) {
                try { Files.deleteIfExists(target); } catch (IOException ignore) { /* 残片清理失败不掩盖主错 */ }
                fetchStates.put(spec.id(), new FetchState(false, done, spec.files().size(), f,
                        "拉取 " + f + " 失败: " + e.getMessage() + "——服务器需能访问 " + MIRROR + "，或把文件手动放入 models/stt/"));
                return;
            }
        }
        fetchStates.put(spec.id(), new FetchState(false, done, spec.files().size(), "", null));
    }

    /** 删除整个模型版本（目录级；管理端按资源操作，不暴露文件粒度）。 */
    public void deleteModel(String id) {
        ModelSpec spec = CATALOG.stream().filter(m -> m.id().equals(id)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("未知模型: " + id));
        Path base = baseDir();
        // 模型根目录 = 文件清单第一项的前两段（org/model）
        String[] seg = spec.files().get(0).split("/", 3);
        Path dir = resolveSafe(seg[0] + "/" + seg[1]);
        if (!Files.isDirectory(dir)) return;
        try (Stream<Path> s = Files.walk(dir)) {
            s.sorted(Comparator.reverseOrder()).forEach(p -> {
                try { Files.delete(p); } catch (IOException e) { throw new RuntimeException(e); }
            });
        } catch (IOException | RuntimeException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "删除失败: " + e.getMessage());
        }
        fetchStates.remove(id);
    }

    // ── 运行时安装包（Docker 运行时 dmg 等）：无外网员工从企业下载页获取，本地沙箱前置组件 ──

    @Value("${iml.runtime-packages-dir:./resources/runtime-packages}")
    private String runtimePkgDir;

    private Path runtimeBase() { return Path.of(runtimePkgDir).toAbsolutePath().normalize(); }

    public List<ResourceFile> listRuntimePackages() {
        Path base = runtimeBase();
        if (!Files.isDirectory(base)) return List.of();
        try (Stream<Path> s = Files.list(base)) {
            return s.filter(Files::isRegularFile)
                    .map(f -> {
                        try {
                            return new ResourceFile(f.getFileName().toString(), Files.size(f),
                                    Files.getLastModifiedTime(f).toMillis());
                        } catch (IOException e) { return null; }
                    })
                    .filter(x -> x != null)
                    .sorted(Comparator.comparing(ResourceFile::path))
                    .toList();
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "读取安装包目录失败: " + e.getMessage());
        }
    }

    public ResourceFile uploadRuntimePackage(MultipartFile file) {
        String name = Path.of(file.getOriginalFilename() == null ? "" : file.getOriginalFilename())
                .getFileName().toString();
        if (name.isBlank()) throw new IllegalArgumentException("文件名为空");
        Path target = runtimeBase().resolve(name).normalize();
        if (!target.startsWith(runtimeBase())) throw new IllegalArgumentException("非法文件名");
        try {
            Files.createDirectories(target.getParent());
            file.transferTo(target);
            return new ResourceFile(name, Files.size(target), Files.getLastModifiedTime(target).toMillis());
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "保存失败: " + e.getMessage());
        }
    }

    public void deleteRuntimePackage(String name) {
        Path target = runtimeBase().resolve(Path.of(name).getFileName().toString()).normalize();
        if (!target.startsWith(runtimeBase())) throw new IllegalArgumentException("非法文件名");
        try {
            if (!Files.deleteIfExists(target)) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "文件不存在: " + name);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "删除失败: " + e.getMessage());
        }
    }

    public Path runtimePackageFile(String name) {
        Path target = runtimeBase().resolve(Path.of(name).getFileName().toString()).normalize();
        if (!target.startsWith(runtimeBase()) || !Files.isRegularFile(target)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "安装包不存在: " + name);
        }
        return target;
    }

    // ── 客户端安装包（平台托管 + 版本管理）：上传打包产物→登记版本元数据，公开下载页从这里读 ──
    // 元数据存 index.json（写操作 synchronized；个位数条目规模，不值得建表）。

    public record ClientPackage(String file, String product, String version,
                                String platform, String arch, long sizeBytes, long updatedAt) {}

    @Value("${iml.client-packages-dir:./resources/client-packages}")
    private String clientPkgDir;

    private Path clientPkgBase() { return Path.of(clientPkgDir).toAbsolutePath().normalize(); }
    private Path clientPkgIndex() { return clientPkgBase().resolve("index.json"); }

    private static final com.fasterxml.jackson.databind.ObjectMapper JSON = new com.fasterxml.jackson.databind.ObjectMapper();

    public synchronized List<ClientPackage> listClientPackages() {
        Path idx = clientPkgIndex();
        if (!Files.isRegularFile(idx)) return List.of();
        try {
            ClientPackage[] arr = JSON.readValue(Files.readAllBytes(idx), ClientPackage[].class);
            return java.util.Arrays.asList(arr);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "读取安装包索引失败: " + e.getMessage());
        }
    }

    private synchronized void saveClientIndex(List<ClientPackage> list) {
        try {
            Files.createDirectories(clientPkgBase());
            Files.write(clientPkgIndex(), JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(list));
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "写入安装包索引失败: " + e.getMessage());
        }
    }

    public synchronized ClientPackage uploadClientPackage(MultipartFile file, String product, String version,
                                                          String platform, String arch) {
        String name = Path.of(file.getOriginalFilename() == null ? "" : file.getOriginalFilename())
                .getFileName().toString();
        if (name.isBlank()) throw new IllegalArgumentException("文件名为空");
        if (product == null || product.isBlank()) throw new IllegalArgumentException("产品不能为空");
        if (version == null || version.isBlank()) throw new IllegalArgumentException("版本号不能为空");
        Path target = clientPkgBase().resolve(name).normalize();
        if (!target.startsWith(clientPkgBase())) throw new IllegalArgumentException("非法文件名");
        try {
            Files.createDirectories(target.getParent());
            file.transferTo(target);
            ClientPackage rec = new ClientPackage(name, product.trim(), version.trim(),
                    platform == null ? "" : platform.trim(), arch == null ? "" : arch.trim(),
                    Files.size(target), System.currentTimeMillis());
            var list = new ArrayList<>(listClientPackages());
            list.removeIf(x -> x.file().equals(name));   // 同名覆盖：索引去重
            list.add(rec);
            saveClientIndex(list);
            return rec;
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "保存失败: " + e.getMessage());
        }
    }

    public synchronized void deleteClientPackage(String name) {
        Path target = clientPkgBase().resolve(Path.of(name).getFileName().toString()).normalize();
        if (!target.startsWith(clientPkgBase())) throw new IllegalArgumentException("非法文件名");
        try { Files.deleteIfExists(target); } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "删除失败: " + e.getMessage());
        }
        var list = new ArrayList<>(listClientPackages());
        list.removeIf(x -> x.file().equals(Path.of(name).getFileName().toString()));
        saveClientIndex(list);
    }

    public Path clientPackageFile(String name) {
        Path target = clientPkgBase().resolve(Path.of(name).getFileName().toString()).normalize();
        if (!target.startsWith(clientPkgBase()) || !Files.isRegularFile(target)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "安装包不存在: " + name);
        }
        return target;
    }

    /** 相对路径解析 + 穿越防护（与 SttModelService 同规）。 */
    private Path resolveSafe(String relative) {
        String cleaned = (relative == null ? "" : relative).replace('\\', '/');
        if (cleaned.isBlank()) throw new IllegalArgumentException("路径为空");
        Path base = baseDir();
        Path target = base.resolve(cleaned).normalize();
        if (!target.startsWith(base)) throw new IllegalArgumentException("非法路径");
        return target;
    }
}
