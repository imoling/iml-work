package com.imlwork.admin.controller;

import com.imlwork.admin.service.RuntimeMonitorService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 运行监控（系统健康维度）：JVM / HTTP 流量 / 数据库连接池 / 依赖服务。
 * 权限沿用 admin.dashboard.view（运行总览-查看）；业务维度总览见 {@link DashboardController}。
 */
@RestController
@RequestMapping("/api/v1/monitor")
public class MonitorController {

    private final RuntimeMonitorService monitor;

    public MonitorController(RuntimeMonitorService monitor) {
        this.monitor = monitor;
    }

    @GetMapping("/overview")
    public ResponseEntity<Map<String, Object>> overview() {
        return ResponseEntity.ok(monitor.overview());
    }
}
