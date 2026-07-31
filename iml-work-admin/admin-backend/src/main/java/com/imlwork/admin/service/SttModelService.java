package com.imlwork.admin.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 离线语音模型（whisper）文件托管：客户端语音输入的本地模型改从企业平台下载，
 * 不再依赖公网 HF 镜像（内网部署也能用）。模型文件由运维放置在 {iml.stt-models-dir}，
 * 目录结构与 HF 仓库一致（如 onnx-community/whisper-base/onnx/encoder_model_quantized.onnx），
 * 不入 git（见 .gitignore）；部署清单见 RUNBOOK。
 */
@Service
public class SttModelService {

    @Value("${iml.stt-models-dir:./models/stt}")
    private String modelsDir;

    /**
     * 把请求相对路径（HF 风格，含 resolve/{revision} 段）解析成磁盘文件。
     * 例：onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx
     *   → {dir}/onnx-community/whisper-base/onnx/encoder_model_quantized.onnx
     */
    public Path resolveFile(String relativePath) {
        // 去掉 HF URL 里的 /resolve/{revision}/ 段——磁盘上不按 revision 分层
        String cleaned = relativePath.replaceFirst("/resolve/[^/]+/", "/");
        Path base = Path.of(modelsDir).toAbsolutePath().normalize();
        Path file = base.resolve(cleaned).normalize();
        // 路径穿越防护：解析结果必须仍在模型目录内
        if (!file.startsWith(base)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "模型文件不存在");
        }
        if (!Files.isRegularFile(file)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "模型文件不存在: " + cleaned);
        }
        return file;
    }
}
