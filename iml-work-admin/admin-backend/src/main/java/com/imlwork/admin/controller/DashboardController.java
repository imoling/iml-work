package com.imlwork.admin.controller;

import com.imlwork.admin.service.DashboardService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 运营驾驶舱：总览 / 时序 / 运行总览三个只读端点，聚合口径见 {@link DashboardService}。
 */
@RestController
@RequestMapping("/api/v1/dashboard")
public class DashboardController {

    private final DashboardService dashboardService;

    public DashboardController(DashboardService dashboardService) {
        this.dashboardService = dashboardService;
    }

    @GetMapping("/overview")
    public ResponseEntity<Map<String, Object>> overview() {
        return ResponseEntity.ok(dashboardService.overview());
    }

    /** 真实 7 日时序 + 中转站各通道流量分布。 */
    @GetMapping("/timeseries")
    public ResponseEntity<Map<String, Object>> timeseries() {
        return ResponseEntity.ok(dashboardService.timeseries());
    }

    /** 运行总览：业务任务维度的真实聚合（口径与数据来源见 Service 注释）。 */
    @GetMapping("/operations")
    public ResponseEntity<Map<String, Object>> operations(@RequestParam(defaultValue = "7") int days) {
        return ResponseEntity.ok(dashboardService.operations(days));
    }
}
