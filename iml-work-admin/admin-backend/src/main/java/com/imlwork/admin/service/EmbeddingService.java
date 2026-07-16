package com.imlwork.admin.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Produces dense embeddings for RAG.
 *
 * <p>When {@code rag.embedding.endpoint} is configured the service calls an
 * OpenAI-compatible {@code /embeddings} endpoint (or a TEI server fronting a
 * bge model). When it is empty the service falls back to a deterministic local
 * feature-hashing vectorizer so retrieval still produces real lexical-similarity
 * rankings against pgvector without an external model server.
 */
@Service
public class EmbeddingService {

    private static final Logger log = LoggerFactory.getLogger(EmbeddingService.class);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${rag.embedding.dimension:384}")
    private int dimension;

    @Value("${rag.embedding.endpoint:}")
    private String endpoint;

    /** 向量请求超时（秒）。共享机/CPU 推理环境延迟波动大（实测热态 6~14s、冷载 12s+），
     *  20s 硬编码会间歇超时 → RAG 检索失败 → 用户看到"数据拿不到"。外置可配，运维按机器实况调。 */
    @Value("${rag.embedding.timeout-seconds:45}")
    private int timeoutSeconds;

    @Value("${rag.embedding.api-key:}")
    private String apiKey;

    @Value("${rag.embedding.model:bge-large-zh-v1.5}")
    private String model;

    public int getDimension() {
        return dimension;
    }

    /** Returns true when a real remote embedding model is wired up. */
    public boolean isRemote() {
        return endpoint != null && !endpoint.isBlank();
    }

    /**
     * 生成向量。
     *
     * ⚠️ 配了 endpoint 却调用失败时 **直接抛错，绝不回退到哈希兜底**。
     *
     * 原来是"失败就静默 fallback 到 localEmbed"，这比报错危险得多：
     *   ① 已入库的向量是**语义模型**算的（bge-m3/ 1024 维语义空间），查询时却用**哈希向量**去比——
     *      两个毫不相干的空间做余弦相似度，得到的分数**看着像分数，实则荒谬**。
     *      实测向量服务一停，「动态虾池」的相似度从 0.783 掉到 **0.063**，知识库彻底失效。
     *   ② 它**不报错、不提示**，用户完全看不出来。运维以为"知识库就这水平"。
     * 宁可让这次检索失败（调用方 degrade 成 []、如实告知"没查到"），也不能给出荒谬的相似度。
     *
     * 哈希兜底只在**压根没配 endpoint** 时使用（纯离线/演示环境，且全库向量都由它生成 —— 空间自洽）。
     */
    /**
     * 健康探测：真发一次向量请求（不是只 ping 端口）——容器活着但模型没拉进去，端口照样通，
     * 但一调用就 model_not_found。只探端口的健康检查是自欺欺人。
     */
    public Map<String, Object> health() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("configured", isRemote());
        m.put("endpoint", endpoint == null ? "" : endpoint);
        m.put("model", model);
        m.put("dimension", dimension);
        if (!isRemote()) {
            m.put("ok", false);
            m.put("mode", "本地特征哈希兜底（非语义模型，检索质量差）");
            return m;
        }
        try {
            float[] v = remoteEmbed("健康检查");
            m.put("ok", true);
            m.put("mode", "远程语义模型");
            m.put("actualDimension", v.length);
            // 维度对不上 = 库里的向量和现在算的不在同一个空间，检索结果毫无意义
            if (v.length != dimension) {
                m.put("ok", false);
                m.put("error", "模型输出维度 " + v.length + " 与配置的 " + dimension
                        + " 不一致——必须改 rag.embedding.dimension、迁移 pgvector 列类型并重建向量");
            }
        } catch (Exception e) {
            m.put("ok", false);
            m.put("mode", "不可达");
            m.put("error", e.getMessage());
        }
        return m;
    }

    public float[] embed(String text) {
        if (isRemote()) {
            try {
                return remoteEmbed(text);
            } catch (Exception e) {
                log.error("[Embedding] 向量服务不可达（{}）：{} —— 拒绝回退到哈希兜底（会与库内语义向量混用，"
                        + "得出荒谬的相似度）。请检查向量服务：bash scripts/docker-services.sh status", endpoint, e.getMessage());
                throw new IllegalStateException("向量服务不可达：" + e.getMessage(), e);
            }
        }
        return localEmbed(text);
    }

    private float[] remoteEmbed(String text) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("input", text);

        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                .timeout(Duration.ofSeconds(timeoutSeconds));
        if (apiKey != null && !apiKey.isBlank()) {
            builder.header("Authorization", "Bearer " + apiKey);
        }

        HttpResponse<String> res = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() < 200 || res.statusCode() >= 300) {
            throw new IllegalStateException("status " + res.statusCode());
        }
        JsonNode root = objectMapper.readTree(res.body());
        JsonNode vec = root.path("data").path(0).path("embedding");
        if (!vec.isArray() || vec.isEmpty()) {
            throw new IllegalStateException("no embedding in response");
        }
        float[] out = new float[vec.size()];
        for (int i = 0; i < vec.size(); i++) {
            out[i] = (float) vec.get(i).asDouble();
        }
        return normalize(out);
    }

    /**
     * Deterministic signed feature-hashing vectorizer over CJK bigrams and ASCII
     * word tokens. Shared substrings raise cosine similarity, so the ranking is
     * a genuine lexical-similarity signal (not random), L2-normalized to unit
     * length so pgvector's cosine distance maps cleanly to {@code 1 - score}.
     */
    public float[] localEmbed(String text) {
        float[] vec = new float[dimension];
        if (text == null || text.isBlank()) {
            return vec;
        }
        String normalized = text.toLowerCase();

        // ASCII word tokens
        for (String token : normalized.split("[^a-z0-9]+")) {
            if (token.length() >= 2) {
                accumulate(vec, "w:" + token);
            }
        }
        // CJK / unicode character bigrams (captures Chinese semantics lexically)
        String compact = normalized.replaceAll("\\s+", "");
        for (int i = 0; i + 1 < compact.length(); i++) {
            accumulate(vec, "b:" + compact.charAt(i) + compact.charAt(i + 1));
        }
        // Unigrams as a weaker signal
        for (int i = 0; i < compact.length(); i++) {
            accumulate(vec, "u:" + compact.charAt(i));
        }
        return normalize(vec);
    }

    private void accumulate(float[] vec, String feature) {
        int h = feature.hashCode();
        int idx = Math.floorMod(h, vec.length);
        float sign = ((h >> 31) & 1) == 0 ? 1f : -1f;
        vec[idx] += sign;
    }

    private float[] normalize(float[] vec) {
        double norm = 0;
        for (float v : vec) {
            norm += v * v;
        }
        norm = Math.sqrt(norm);
        if (norm > 1e-9) {
            for (int i = 0; i < vec.length; i++) {
                vec[i] = (float) (vec[i] / norm);
            }
        }
        return vec;
    }
}
