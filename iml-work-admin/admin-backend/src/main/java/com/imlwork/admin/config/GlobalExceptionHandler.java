package com.imlwork.admin.config;

import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 全局异常兜底：把未被各 Controller 自行处理的异常，统一转成结构化 JSON
 * （{success:false, error, status}），避免走 Spring 默认 /error 外泄内部栈信息。
 * 只兜「漏出来」的异常，不影响 Controller 已有的错误返回。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    private static Map<String, Object> body(int status, String error) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("success", false);
        m.put("error", error);
        m.put("status", status);
        return m;
    }

    /** 显式抛出的 ResponseStatusException：沿用其状态码与原因。 */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> handleStatus(ResponseStatusException ex) {
        int code = ex.getStatusCode().value();
        return ResponseEntity.status(code).body(body(code, ex.getReason() != null ? ex.getReason() : "请求失败"));
    }

    /** 参数非法 / 状态非法 → 400，回显安全的 message。 */
    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, Object>> handleBadRequest(RuntimeException ex) {
        return ResponseEntity.badRequest().body(body(400, ex.getMessage()));
    }

    /** @Valid 请求体校验失败 → 400，汇总字段错误。 */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleValidation(MethodArgumentNotValidException ex) {
        String msg = ex.getBindingResult().getFieldErrors().stream()
                .map(f -> f.getField() + ": " + f.getDefaultMessage())
                .collect(Collectors.joining("; "));
        return ResponseEntity.badRequest().body(body(400, msg.isEmpty() ? "参数校验失败" : msg));
    }

    /** @Validated 方法参数校验失败 → 400。 */
    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<Map<String, Object>> handleConstraint(ConstraintViolationException ex) {
        return ResponseEntity.badRequest().body(body(400, ex.getMessage()));
    }

    /** 兜底：其余未处理异常 → 500。记录完整堆栈到服务端日志，但只回泛化提示给客户端。 */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleGeneric(Exception ex) {
        log.error("未处理异常", ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(body(500, "服务器内部错误，请稍后重试"));
    }
}
