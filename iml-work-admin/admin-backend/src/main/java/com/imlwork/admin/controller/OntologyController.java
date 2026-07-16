package com.imlwork.admin.controller;

import com.imlwork.admin.model.BusinessEvent;
import com.imlwork.admin.model.ObjectRef;
import com.imlwork.admin.model.OntologyAction;
import com.imlwork.admin.model.OntologyType;
import com.imlwork.admin.service.OntologyService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 本体层（Ontology）。仅做 HTTP 塑形；业务在 {@link OntologyService}。
 * 只存 Schema + 对象引用 + 业务事件，绝不存实例业务数据。
 */
@RestController
@RequestMapping("/api/v1/ontology")
public class OntologyController {

    private final OntologyService service;

    public OntologyController(OntologyService service) {
        this.service = service;
    }

    // ── 对象类型 ──
    @GetMapping("/types")
    public List<OntologyType> listTypes(@RequestParam(required = false) String domain) {
        return service.listTypes(domain);
    }

    @GetMapping("/types/{id}")
    public OntologyType getType(@PathVariable String id) {
        return service.getType(id);
    }

    @PostMapping("/types")
    public OntologyType createType(@RequestBody OntologyType body) {
        return service.createType(body);
    }

    @PutMapping("/types/{id}")
    public OntologyType updateType(@PathVariable String id, @RequestBody OntologyType body) {
        return service.updateType(id, body);
    }

    @DeleteMapping("/types/{id}")
    public ResponseEntity<Map<String, Object>> deleteType(@PathVariable String id) {
        service.deleteType(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    // ── 对象动作 ──
    @GetMapping("/actions")
    public List<OntologyAction> listActions(@RequestParam(required = false) String domain,
                                            @RequestParam(required = false) String objectType) {
        return service.listActions(domain, objectType);
    }

    @GetMapping("/actions/{id}")
    public OntologyAction getAction(@PathVariable String id) {
        return service.getAction(id);
    }

    @PostMapping("/actions")
    public OntologyAction createAction(@RequestBody OntologyAction body) {
        return service.createAction(body);
    }

    @PutMapping("/actions/{id}")
    public OntologyAction updateAction(@PathVariable String id, @RequestBody OntologyAction body) {
        return service.updateAction(id, body);
    }

    @DeleteMapping("/actions/{id}")
    public ResponseEntity<Map<String, Object>> deleteAction(@PathVariable String id) {
        service.deleteAction(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    // ── 解析提示 ──
    @GetMapping("/resolve-hints")
    public Map<String, Object> resolveHints(@RequestParam(required = false) String domain) {
        return service.resolveHints(domain);
    }

    /** 设置某岗位有权执行的本体动作（授权入口放在岗位这边，符合"这个岗位能干什么"的直觉）。 */
    @PutMapping("/expert-actions/{expertId}")
    public Map<String, Object> setExpertActions(@PathVariable String expertId, @RequestBody Map<String, List<String>> body) {
        service.setExpertActions(expertId, body.get("actionIds"));
        return Map.of("ok", true);
    }

    // ── 对象引用 ──
    @GetMapping("/object-refs")
    public List<ObjectRef> listRefs(@RequestParam(required = false) String objectType) {
        return service.listRefs(objectType);
    }

    @PostMapping("/object-refs")
    public ObjectRef upsertRef(@RequestBody ObjectRef body) {
        return service.upsertRef(body);
    }

    // ── 业务事件 ──
    @GetMapping("/events")
    public List<BusinessEvent> listEvents(@RequestParam(required = false) String objectRefId) {
        return service.listEvents(objectRefId);
    }

    @PostMapping("/events")
    public BusinessEvent recordEvent(@RequestBody BusinessEvent body) {
        return service.recordEvent(body);
    }
}
