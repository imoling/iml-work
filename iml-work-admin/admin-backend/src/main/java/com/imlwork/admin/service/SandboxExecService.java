package com.imlwork.admin.service;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.command.CreateContainerResponse;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Frame;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.StreamType;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
import com.github.dockerjava.core.command.PullImageResultCallback;
import com.github.dockerjava.httpclient5.ApacheDockerHttpClient;
import com.github.dockerjava.transport.DockerHttpClient;
import com.imlwork.admin.model.SandboxConfig;
import com.imlwork.admin.repository.SandboxConfigRepository;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * 代码执行沙箱：把「代码执行型技能」的脚本放进一次性 Docker 容器里跑（本机 colima 或远程
 * Docker 主机，由 SandboxConfig.dockerEndpoint 决定），产物回传后销毁容器。
 *
 * <p>安全边界：容器 --network none（可配）、内存/CPU 配额、硬超时；代码以 base64 注入、
 * 产物经 stdout 标记回传（无需 bind mount/tar，本地与远程一致）。不可信代码永不在员工机器上跑，
 * 也接触不到任何凭证/本机文件——凭证与业务数据仍留客户端本地平面（RPA 读取）。
 *
 * <p>并发闸：信号量限制同时运行的容器数（防单机资源被打爆）。同步执行——不改 controller 签名、
 * 不碰 Spring Security 异步 re-dispatch 丢 SecurityContext 的坑。同时最多 maxConcurrent 个执行各占
 * 一个 web 线程（N 小，对 Tomcat 线程池可忽略）；超出者短暂等待后返回「繁忙」，不长占线程。
 */
@Service
public class SandboxExecService {

    private final SandboxConfigRepository configRepo;
    private static final String DEFAULT_IMAGE = "python:3.12-slim";
    private static final String FILE_MARKER = "@@IMLFILE@@";

    private final Semaphore slots;
    private final int acquireTimeoutSec;
    private final int maxConcurrent;

    // 复用 DockerClient（按 endpoint 缓存），避免每次执行都新建连接池；坏连接由 invalidateClient() 自愈重建。
    private volatile DockerClient cachedClient;
    private volatile String cachedHost;

    public SandboxExecService(SandboxConfigRepository configRepo,
                              @Value("${sandbox.max-concurrent:4}") int maxConcurrent,
                              @Value("${sandbox.acquire-timeout-sec:5}") int acquireTimeoutSec) {
        this.configRepo = configRepo;
        this.maxConcurrent = Math.max(1, maxConcurrent);
        this.slots = new Semaphore(this.maxConcurrent, true);
        this.acquireTimeoutSec = Math.max(0, acquireTimeoutSec);
    }

    @PreDestroy
    public void shutdown() {
        if (cachedClient != null) { try { cachedClient.close(); } catch (Exception ignore) {} }
    }

    public record FileOut(String name, String base64) {}

    private Map<String, Object> busyResponse() {
        Map<String, Object> busy = new LinkedHashMap<>();
        busy.put("ok", false);
        busy.put("error", "沙箱繁忙：并发执行已达上限，请稍后重试");
        busy.put("files", List.of());
        busy.put("busy", true);
        return busy;
    }

    // 单例 DockerClient：同一 endpoint 复用；endpoint 变了才重建。
    private synchronized DockerClient client(String host) {
        if (cachedClient != null && host.equals(cachedHost)) return cachedClient;
        if (cachedClient != null) { try { cachedClient.close(); } catch (Exception ignore) {} cachedClient = null; }
        DockerClientConfig config = DefaultDockerClientConfig.createDefaultConfigBuilder()
                .withDockerHost(host).build();
        DockerHttpClient http = new ApacheDockerHttpClient.Builder()
                .dockerHost(config.getDockerHost()).sslConfig(config.getSSLConfig())
                .maxConnections(50).connectionTimeout(Duration.ofSeconds(6)).responseTimeout(Duration.ofSeconds(30))
                .build();
        cachedClient = DockerClientImpl.getInstance(config, http);
        cachedHost = host;
        return cachedClient;
    }

    // 作废并关闭缓存的单例 client：下次 client() 会重建。用于探测/执行失败后自愈坏连接（避免持续 reachable:false）。
    private synchronized void invalidateClient() {
        if (cachedClient != null) { try { cachedClient.close(); } catch (Exception ignore) {} }
        cachedClient = null;
        cachedHost = null;
    }

    /** 探测 Docker 沙箱是否可用（供状态展示）。不 close 复用的单例 client；探测失败即作废缓存，下次重建。 */
    public Map<String, Object> status() {
        SandboxConfig cfg = cfg();
        String image = imageOf(cfg);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("mode", cfg.getMode());
        m.put("dockerEndpoint", cfg.getDockerEndpoint());
        m.put("maxConcurrent", maxConcurrent);                 // 并发执行槽位上限（容量分母）
        m.put("runningSlots", maxConcurrent - slots.availablePermits());  // 当前占用中的执行位（容量分子）
        try {
            DockerClient d = client(cfg.getDockerEndpoint());
            d.pingCmd().exec();
            m.put("reachable", true);
            boolean img = false;
            try { d.inspectImageCmd(image).exec(); img = true; } catch (NotFoundException ignore) {}
            m.put("imageReady", img);
            m.put("image", image);
        } catch (Exception e) {
            invalidateClient();
            m.put("reachable", false);
            m.put("error", e.getMessage());
        }
        return m;
    }

    private SandboxConfig cfg() {
        return configRepo.findById(1L).orElseGet(SandboxConfig::new);
    }

    private String imageOf(SandboxConfig cfg) {
        String i = cfg.getBaseImage();
        return (i == null || i.isBlank()) ? DEFAULT_IMAGE : i;
    }

    public Map<String, Object> exec(String code, List<String> packages) {
        return exec(code, packages, Map.of());
    }

    /**
     * 在一次性容器内执行 Python 代码；产物写入 /out（与旧客户端约定一致）或 /work/out 的文件回传。
     * files：随执行铺进容器 /work 的附属文件（相对路径 → base64），用于 agentic 技能的 bundle
     * （SKILL.md + scripts/**）——驱动脚本可直接 import/调用它们。经 docker tar 上传，无命令行长度限制。
     */
    public Map<String, Object> exec(String code, List<String> packages, Map<String, String> files) {
        SandboxConfig cfg = cfg();
        Map<String, Object> out = new LinkedHashMap<>();
        if ("disabled".equalsIgnoreCase(cfg.getMode())) {
            out.put("ok", false);
            out.put("error", "代码执行沙箱已停用（管理员在「沙箱监控」中关闭）");
            out.put("files", List.of());
            return out;
        }

        // 并发闸：拿不到执行位（已达上限）→ 短暂等待后返回「繁忙」，不打爆主机、不长占 web 线程。
        boolean acquired;
        try { acquired = slots.tryAcquire(acquireTimeoutSec, TimeUnit.SECONDS); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return busyResponse(); }
        if (!acquired) return busyResponse();

        boolean isolate = cfg.isNetworkIsolation() && (packages == null || packages.isEmpty());
        String image = imageOf(cfg);
        String containerId = null;
        DockerClient d = null;
        boolean dockerError = false;
        try {
            d = client(cfg.getDockerEndpoint());
            try { d.inspectImageCmd(image).exec(); }
            catch (NotFoundException e) { d.pullImageCmd(image).exec(new PullImageResultCallback()).awaitCompletion(5, TimeUnit.MINUTES); }

            String pip = (packages != null && !packages.isEmpty())
                    ? "pip install --quiet --no-warn-script-location --disable-pip-version-check " + String.join(" ", sanitizePkgs(packages)) + " >&2; " : "";
            // 包装脚本：装包 → 跑（main.py 与 bundle 文件已经 tar 上传进 /work）→ 把产物以标记行 base64 回传。
            // 产物目录统一约定 /out，兼容相对 /work/out。
            String wrapper = "set -e; mkdir -p /out /work/out; "
                    + pip + "python /work/main.py; "
                    + "for f in /out/* /work/out/*; do [ -f \"$f\" ] && echo \"" + FILE_MARKER + " $(basename \"$f\") $(base64 -w0 \"$f\")\"; done";

            HostConfig hc = HostConfig.newHostConfig()
                    .withMemory((long) Math.max(64, cfg.getMemoryQuotaMb()) * 1024 * 1024)
                    .withCpuPeriod(100_000L)
                    .withCpuQuota((long) (Math.max(0.25, cfg.getCpuQuota()) * 100_000L))
                    .withPidsLimit(256L);
            if (isolate) hc.withNetworkMode("none");

            CreateContainerResponse c = d.createContainerCmd(image)
                    .withHostConfig(hc).withWorkingDir("/work")
                    .withEntrypoint("sh", "-c").withCmd(wrapper)
                    .exec();
            containerId = c.getId();
            // 代码 + bundle 经 tar 上传进 /work（无 shell 参数长度限制；bundle 可达 MB 级）
            d.copyArchiveToContainerCmd(containerId).withRemotePath("/work")
                    .withTarInputStream(new ByteArrayInputStream(buildTar(code, files))).exec();
            d.startContainerCmd(containerId).exec();

            StringBuilder so = new StringBuilder(), se = new StringBuilder();
            d.logContainerCmd(containerId).withStdOut(true).withStdErr(true).withFollowStream(true).withTailAll()
                    .exec(new ResultCallback.Adapter<Frame>() {
                        @Override public void onNext(Frame f) {
                            String s = new String(f.getPayload(), StandardCharsets.UTF_8);
                            if (f.getStreamType() == StreamType.STDERR) se.append(s); else so.append(s);
                        }
                    }).awaitCompletion(Math.max(5, cfg.getTimeoutSeconds()), TimeUnit.SECONDS);

            // 解析 stdout：标记行为产物文件，其余为真实输出
            List<FileOut> outFiles = new ArrayList<>();
            StringBuilder realOut = new StringBuilder();
            for (String line : so.toString().split("\n")) {
                if (line.startsWith(FILE_MARKER + " ")) {
                    String[] p = line.substring(FILE_MARKER.length() + 1).split(" ", 2);
                    if (p.length == 2) outFiles.add(new FileOut(p[0], p[1].trim()));
                } else realOut.append(line).append("\n");
            }
            out.put("ok", se.length() == 0 || !se.toString().contains("Traceback"));
            out.put("stdout", realOut.toString().trim());
            out.put("stderr", se.toString().trim());
            out.put("files", outFiles.stream().map(f -> Map.of("name", f.name(), "base64", f.base64())).toList());
            out.put("networkIsolated", isolate);
            return out;
        } catch (Exception e) {
            dockerError = true;
            out.put("ok", false);
            out.put("error", "沙箱执行失败：" + e.getMessage());
            out.put("files", List.of());
            return out;
        } finally {
            // 先尽力删容器（此时 d 尚未关闭）
            if (d != null && containerId != null) {
                try { d.removeContainerCmd(containerId).withForce(true).exec(); } catch (Exception ignore) {}
            }
            // 单例 client 复用，正常不 close；仅本次通信出错时作废，让下次重建自愈坏连接。
            if (dockerError) invalidateClient();
            slots.release();   // 释放并发闸执行位（能进入本 try 即已 acquire 成功）
        }
    }

    /**
     * 把驱动代码(main.py) + bundle 附属文件打成 tar（内存），供 docker copyArchive 上传进 /work。
     * 路径校验：拒绝绝对路径与 ..（防写出 /work 外）；上限 200 个文件 / 解码后共 8MB。
     */
    private static byte[] buildTar(String code, Map<String, String> files) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (TarArchiveOutputStream tar = new TarArchiveOutputStream(bos)) {
            tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX);
            byte[] main = code.getBytes(StandardCharsets.UTF_8);
            TarArchiveEntry me = new TarArchiveEntry("main.py");
            me.setSize(main.length);
            tar.putArchiveEntry(me); tar.write(main); tar.closeArchiveEntry();

            if (files != null && !files.isEmpty()) {
                if (files.size() > 200) throw new IllegalArgumentException("bundle 文件数超过 200 上限");
                long total = 0;
                for (Map.Entry<String, String> e : files.entrySet()) {
                    String path = e.getKey() == null ? "" : e.getKey().trim();
                    if (path.isEmpty() || path.startsWith("/") || path.contains("..") || path.contains("\0"))
                        throw new IllegalArgumentException("非法 bundle 路径：" + path);
                    byte[] data;
                    try { data = Base64.getDecoder().decode(e.getValue()); }
                    catch (Exception ex) { throw new IllegalArgumentException("bundle 文件非法 base64：" + path); }
                    total += data.length;
                    if (total > 8L * 1024 * 1024) throw new IllegalArgumentException("bundle 解码后超过 8MB 上限");
                    TarArchiveEntry te = new TarArchiveEntry(path);
                    te.setSize(data.length);
                    tar.putArchiveEntry(te); tar.write(data); tar.closeArchiveEntry();
                }
            }
        }
        return bos.toByteArray();
    }

    /** 包名白名单字符，防命令注入进 pip 行。 */
    private static List<String> sanitizePkgs(List<String> pkgs) {
        List<String> ok = new ArrayList<>();
        for (String p : pkgs) if (p != null && p.matches("[A-Za-z0-9_.\\-]{1,50}")) ok.add(p);
        return ok;
    }
}
