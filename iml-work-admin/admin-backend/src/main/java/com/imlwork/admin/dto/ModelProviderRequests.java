package com.imlwork.admin.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;

/**
 * 模型网关通道写请求 DTO（替代直接拿 ModelProvider 实体当请求契约）。
 * id / status / 实时计数器(totalRequests…) / lastChecked 均服务端管理，不接受客户端设置。
 * 单价可空=不计费；apiKey 更新时留空=不改（服务层判空）。create/update 同形状（整表替换语义）。
 */
public final class ModelProviderRequests {
    private ModelProviderRequests() {}

    public record Upsert(
            @NotBlank(message = "通道名不能为空") @Size(max = 100, message = "通道名过长") String name,
            @NotBlank(message = "厂商类型不能为空") String provider,
            @NotBlank(message = "上游地址不能为空") String baseUrl,
            String apiKey,
            @NotBlank(message = "模型名不能为空") String model,
            String routeKey,
            Integer weight,
            Boolean enabled,
            @PositiveOrZero(message = "输入单价不能为负") Double inputPricePer1k,
            @PositiveOrZero(message = "输出单价不能为负") Double outputPricePer1k) {}
}
