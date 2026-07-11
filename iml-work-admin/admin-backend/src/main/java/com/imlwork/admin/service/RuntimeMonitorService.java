package com.imlwork.admin.service;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

import javax.sql.DataSource;
import java.io.File;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.RuntimeMXBean;
import java.lang.management.ThreadMXBean;
import java.sql.Connection;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 管理端「运行监控」页的系统健康聚合：JVM / HTTP 流量 / 数据库连接池 / 依赖服务。
 * <p>与业务总览（{@link DashboardService}，任务/技能维度）互补，本服务只看系统运行面。
 * 指标来自 Micrometer（actuator 引入），不直接暴露 actuator 端点，统一经
 * {@code /api/v1/monitor/overview} 按权限输出。
 * <p>依赖探测（docker ping / docling probe）相对重，做 10 秒缓存：前端 5 秒轮询时
 * JVM/HTTP/DB 每次都是新鲜值，外部依赖至多 10 秒一探，避免轮询打爆探测目标。
 */
@Service
public class RuntimeMonitorService {

    private static final long DEPS_CACHE_MS = 10_000;

    private final MeterRegistry meters;
    private final DataSource dataSource;
    private final Environment env;
    private final DockerMonitorService dockerMonitor;
    private final SandboxConfigService sandboxConfig;
    private final DoclingService docling;
    private final ModelProviderService modelProviders;
    private final ClientNodeService clientNodes;

    private volatile Map<String, Object> cachedDeps;
    private volatile long cachedDepsAt;

    public RuntimeMonitorService(MeterRegistry meters, DataSource dataSource, Environment env,
                                 DockerMonitorService dockerMonitor, SandboxConfigService sandboxConfig,
                                 DoclingService docling, ModelProviderService modelProviders,
                                 ClientNodeService clientNodes) {
        this.meters = meters;
        this.dataSource = dataSource;
        this.env = env;
        this.dockerMonitor = dockerMonitor;
        this.sandboxConfig = sandboxConfig;
        this.docling = docling;
        this.modelProviders = modelProviders;
        this.clientNodes = clientNodes;
    }

    /** 一次性聚合全部运行指标（每项独立容错，任一依赖故障不影响其余输出）。 */
    public Map<String, Object> overview() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("jvm", jvm());
        out.put("http", http());
        out.put("db", db());
        out.put("deps", depsCached());
        return out;
    }

    // ── JVM：内存 / 线程 / CPU / GC / 运行时长 ──
    private Map<String, Object> jvm() {
        Map<String, Object> m = new LinkedHashMap<>();
        RuntimeMXBean rt = ManagementFactory.getRuntimeMXBean();
        MemoryMXBean mem = ManagementFactory.getMemoryMXBean();
        ThreadMXBean threads = ManagementFactory.getThreadMXBean();
        m.put("uptimeMs", rt.getUptime());
        m.put("heapUsed", mem.getHeapMemoryUsage().getUsed());
        m.put("heapMax", mem.getHeapMemoryUsage().getMax());
        m.put("nonHeapUsed", mem.getNonHeapMemoryUsage().getUsed());
        m.put("threadCount", threads.getThreadCount());
        m.put("threadPeak", threads.getPeakThreadCount());
        m.put("virtualThreads", "true".equalsIgnoreCase(env.getProperty("spring.threads.virtual.enabled", "false")));
        m.put("processors", Runtime.getRuntime().availableProcessors());
        // CPU：com.sun.management 扩展（标准 JDK 均有）；不可用时返回 -1，前端显示「采集中」
        java.lang.management.OperatingSystemMXBean osBase = ManagementFactory.getOperatingSystemMXBean();
        double processCpu = -1, systemCpu = -1;
        if (osBase instanceof com.sun.management.OperatingSystemMXBean os) {
            processCpu = os.getProcessCpuLoad();
            systemCpu = os.getCpuLoad();
        }
        m.put("processCpu", processCpu);
        m.put("systemCpu", systemCpu);
        long gcCount = 0, gcTimeMs = 0;
        for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
            if (gc.getCollectionCount() > 0) { gcCount += gc.getCollectionCount(); gcTimeMs += gc.getCollectionTime(); }
        }
        m.put("gcCount", gcCount);
        m.put("gcTimeMs", gcTimeMs);
        File cwd = new File(".");
        m.put("diskUsable", cwd.getUsableSpace());
        m.put("diskTotal", cwd.getTotalSpace());
        return m;
    }

    // ── HTTP 流量：累计请求 / 5xx / 延迟（自启动累计；QPS 由前端两次采样差分得出）──
    private Map<String, Object> http() {
        Map<String, Object> m = new LinkedHashMap<>();
        long total = 0, errors5xx = 0;
        double totalTimeMs = 0, maxMs = 0;
        for (Timer t : meters.find("http.server.requests").timers()) {
            total += t.count();
            totalTimeMs += t.totalTime(TimeUnit.MILLISECONDS);
            maxMs = Math.max(maxMs, t.max(TimeUnit.MILLISECONDS));
            String status = t.getId().getTag("status");
            if (status != null && status.startsWith("5")) errors5xx += t.count();
        }
        m.put("totalRequests", total);
        m.put("errors5xx", errors5xx);
        m.put("avgLatencyMs", total > 0 ? Math.round(totalTimeMs / total * 10) / 10.0 : 0);
        m.put("maxLatencyMs", Math.round(maxMs));
        return m;
    }

    // ── 数据库：连通性延迟 + Hikari 连接池水位 ──
    private Map<String, Object> db() {
        Map<String, Object> m = new LinkedHashMap<>();
        long t0 = System.nanoTime();
        try (Connection c = dataSource.getConnection(); Statement s = c.createStatement()) {
            s.execute("SELECT 1");
            m.put("ok", true);
            m.put("pingMs", Math.round((System.nanoTime() - t0) / 1_000_000.0 * 10) / 10.0);
        } catch (Exception e) {
            m.put("ok", false);
            m.put("error", e.getMessage());
        }
        m.put("poolActive", gauge("hikaricp.connections.active"));
        m.put("poolIdle", gauge("hikaricp.connections.idle"));
        m.put("poolPending", gauge("hikaricp.connections.pending"));
        m.put("poolMax", gauge("hikaricp.connections.max"));
        return m;
    }

    private double gauge(String name) {
        Gauge g = meters.find(name).gauge();
        return g != null ? g.value() : -1;
    }

    // ── 依赖服务健康（10s 缓存）：沙箱 Docker / docling / 模型网关 / 客户端节点 ──
    private Map<String, Object> depsCached() {
        long now = System.currentTimeMillis();
        Map<String, Object> cached = cachedDeps;
        if (cached != null && now - cachedDepsAt < DEPS_CACHE_MS) return cached;
        Map<String, Object> m = probeDeps();
        cachedDeps = m;
        cachedDepsAt = now;
        return m;
    }

    private Map<String, Object> probeDeps() {
        Map<String, Object> m = new LinkedHashMap<>();
        try {
            String endpoint = sandboxConfig.getOrCreate().getDockerEndpoint();
            Map<String, Object> ping = dockerMonitor.ping(endpoint);
            m.put("sandboxDocker", ping);
        } catch (Exception e) {
            m.put("sandboxDocker", Map.of("ok", false, "error", String.valueOf(e.getMessage())));
        }
        try {
            var s = docling.settings();
            docling.checkHealth(false); // 自带 ~15s 缓存
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("endpoint", s.getEndpoint());
            d.put("healthy", docling.isOnline());
            d.put("latencyMs", docling.getLastProbeLatencyMs());
            if (docling.getLastProbeError() != null) d.put("error", docling.getLastProbeError());
            m.put("docling", d);
        } catch (Exception e) {
            m.put("docling", Map.of("healthy", false, "error", String.valueOf(e.getMessage())));
        }
        try {
            m.put("modelGateway", modelProviders.summary());
        } catch (Exception e) {
            m.put("modelGateway", Map.of("error", String.valueOf(e.getMessage())));
        }
        try {
            var nodes = clientNodes.listWithStatus();
            long online = nodes.stream().filter(n -> Boolean.TRUE.equals(n.get("online"))).count();
            m.put("clients", Map.of("online", online, "total", nodes.size()));
        } catch (Exception e) {
            m.put("clients", Map.of("error", String.valueOf(e.getMessage())));
        }
        return m;
    }
}
