package com.imlwork.admin.service;

import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class RagService {

    public static class Chunk {
        private String documentId;
        private String text;
        private float[] embedding; // Simulated vector embedding

        public Chunk(String documentId, String text, float[] embedding) {
            this.documentId = documentId;
            this.text = text;
            this.embedding = embedding;
        }

        public String getDocumentId() { return documentId; }
        public String getText() { return text; }
        public float[] getEmbedding() { return embedding; }
    }

    private final List<Chunk> vectorDatabase = new ArrayList<>();

    public RagService() {
        // Seed default corporate knowledge chunks
        addMockChunk("corp-doc-1", "公司全称：北京艾姆尔人工智能科技有限公司。纳税人识别号：91110108MA01XXXXXX。");
        addMockChunk("corp-doc-2", "公司差旅与福利报销规范：华东/华北区酒店限额 500元/天，伙食补贴 100元/天。超出需VP审批。");
        addMockChunk("corp-doc-3", "公章申请审批细则：对外合同公章盖印需经法务评审通过后，由销售分管VP与人力VP会签。公章保管在行政前台保险箱。");
    }

    private void addMockChunk(String docId, String text) {
        vectorDatabase.add(new Chunk(docId, text, mockGenerateEmbedding(text)));
    }

    public List<Chunk> query(String queryText, int topK) {
        float[] queryEmbedding = mockGenerateEmbedding(queryText);
        
        // Sort by simulated cosine similarity
        return vectorDatabase.stream()
                .sorted((c1, c2) -> Float.compare(
                        cosineSimilarity(c2.getEmbedding(), queryEmbedding),
                        cosineSimilarity(c1.getEmbedding(), queryEmbedding)
                ))
                .limit(topK)
                .collect(Collectors.toList());
    }

    public void processAndAddDocument(String docId, String content) {
        // Split text by sentence or length (e.g. 100 chars)
        String[] sentences = content.split("(?<=[。！？\n])");
        for (String sentence : sentences) {
            if (sentence.trim().length() > 5) {
                addMockChunk(docId, sentence.trim());
            }
        }
    }

    // Cosine similarity between two float arrays
    private float cosineSimilarity(float[] vectorA, float[] vectorB) {
        float dotProduct = 0.0f;
        float normA = 0.0f;
        float normB = 0.0f;
        for (int i = 0; i < vectorA.length; i++) {
            dotProduct += vectorA[i] * vectorB[i];
            normA += vectorA[i] * vectorA[i];
            normB += vectorB[i] * vectorB[i];
        }
        return dotProduct / ((float) Math.sqrt(normA) * (float) Math.sqrt(normB));
    }

    // Helper to generate a deterministic float vector based on string hash
    private float[] mockGenerateEmbedding(String text) {
        float[] vector = new float[384]; // 384-dimension vector (like bge-small)
        int seed = text.hashCode();
        java.util.Random random = new java.util.Random(seed);
        for (int i = 0; i < 384; i++) {
            vector[i] = random.nextFloat() - 0.5f;
        }
        return vector;
    }
}
