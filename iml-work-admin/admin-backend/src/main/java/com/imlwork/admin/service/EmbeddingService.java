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

    public float[] embed(String text) {
        if (isRemote()) {
            try {
                return remoteEmbed(text);
            } catch (Exception e) {
                log.warn("[Embedding] Remote endpoint failed ({}), falling back to local: {}",
                        endpoint, e.getMessage());
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
                .timeout(Duration.ofSeconds(20));
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
