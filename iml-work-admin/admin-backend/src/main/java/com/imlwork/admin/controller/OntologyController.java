package com.imlwork.admin.controller;

import com.imlwork.admin.model.BusinessEvent;
import com.imlwork.admin.model.ObjectRef;
import com.imlwork.admin.model.OntologyAction;
import com.imlwork.admin.model.OntologyType;
import com.imlwork.admin.repository.BusinessEventRepository;
import com.imlwork.admin.repository.ObjectRefRepository;
import com.imlwork.admin.repository.OntologyActionRepository;
import com.imlwork.admin.repository.OntologyTypeRepository;
import com.imlwork.admin.security.JwtAuthFilter;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 本体层（Ontology）：对象类型 / 对象动作的注册，以及对象引用 / 业务事件的登记与审计。
 *
 * 安全边界：本表只存 Schema + 对象引用 + 业务事件，绝不存实例业务数据。
 * 读（types/actions/resolve-hints）与写事件（events/object-refs）对任一登录用户开放（含客户端员工）；
 * 改本体定义（types/actions 的写操作）需 admin.ontology.manage。
 */
@RestController
@RequestMapping("/api/v1/ontology")
public class OntologyController {

    private final OntologyTypeRepository typeRepo;
    private final OntologyActionRepository actionRepo;
    private final ObjectRefRepository refRepo;
    private final BusinessEventRepository eventRepo;

    public OntologyController(OntologyTypeRepository typeRepo, OntologyActionRepository actionRepo,
                              ObjectRefRepository refRepo, BusinessEventRepository eventRepo) {
        this.typeRepo = typeRepo;
        this.actionRepo = actionRepo;
        this.refRepo = refRepo;
        this.eventRepo = eventRepo;
    }

    // ===================== 对象类型 =====================

    @GetMapping("/types")
    public List<OntologyType> listTypes(@RequestParam(required = false) String domain) {
        if (domain != null && !domain.isBlank()) return typeRepo.findByDomainOrderByLabelAsc(domain);
        return typeRepo.findAllByOrderByDomainAscLabelAsc();
    }

    @GetMapping("/types/{id}")
    public ResponseEntity<OntologyType> getType(@PathVariable String id) {
        return typeRepo.findById(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/types")
    public OntologyType createType(@RequestBody OntologyType body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("otype-" + UUID.randomUUID().toString().substring(0, 8));
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return typeRepo.save(body);
    }

    @PutMapping("/types/{id}")
    public ResponseEntity<OntologyType> updateType(@PathVariable String id, @RequestBody OntologyType body) {
        return typeRepo.findById(id).map(t -> {
            t.setDomain(body.getDomain());
            t.setTypeKey(body.getTypeKey());
            t.setLabel(body.getLabel());
            t.setBoundSystemId(body.getBoundSystemId());
            t.setPropertiesJson(body.getPropertiesJson());
            t.setRelationsJson(body.getRelationsJson());
            t.setStateMachineJson(body.getStateMachineJson());
            t.setResolveListPath(body.getResolveListPath());
            t.setDescription(body.getDescription());
            t.setUpdatedAt(LocalDateTime.now());
            return ResponseEntity.ok(typeRepo.save(t));
        }).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/types/{id}")
    public ResponseEntity<Map<String, Object>> deleteType(@PathVariable String id) {
        if (!typeRepo.existsById(id)) return ResponseEntity.notFound().build();
        typeRepo.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    // ===================== 对象动作 =====================

    @GetMapping("/actions")
    public List<OntologyAction> listActions(@RequestParam(required = false) String domain,
                                            @RequestParam(required = false) String objectType) {
        if (objectType != null && !objectType.isBlank()) return actionRepo.findByObjectTypeOrderByActionKeyAsc(objectType);
        if (domain != null && !domain.isBlank()) return actionRepo.findByDomainOrderByObjectTypeAsc(domain);
        return actionRepo.findAllByOrderByDomainAscObjectTypeAsc();
    }

    @GetMapping("/actions/{id}")
    public ResponseEntity<OntologyAction> getAction(@PathVariable String id) {
        return actionRepo.findById(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/actions")
    public OntologyAction createAction(@RequestBody OntologyAction body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("oact-" + UUID.randomUUID().toString().substring(0, 8));
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return actionRepo.save(body);
    }

    @PutMapping("/actions/{id}")
    public ResponseEntity<OntologyAction> updateAction(@PathVariable String id, @RequestBody OntologyAction body) {
        return actionRepo.findById(id).map(a -> {
            a.setDomain(body.getDomain());
            a.setObjectType(body.getObjectType());
            a.setActionKey(body.getActionKey());
            a.setLabel(body.getLabel());
            if (body.getCapability() != null && !body.getCapability().isBlank()) a.setCapability(body.getCapability());
            a.setFromState(body.getFromState());
            a.setToState(body.getToState());
            a.setConnectorActionId(body.getConnectorActionId());
            a.setPolicyJson(body.getPolicyJson());
            a.setDescription(body.getDescription());
            a.setUpdatedAt(LocalDateTime.now());
            return ResponseEntity.ok(actionRepo.save(a));
        }).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/actions/{id}")
    public ResponseEntity<Map<String, Object>> deleteAction(@PathVariable String id) {
        if (!actionRepo.existsById(id)) return ResponseEntity.notFound().build();
        actionRepo.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    // ===================== 解析提示（客户端拉取某域的对象+动作定义） =====================

    @GetMapping("/resolve-hints")
    public Map<String, Object> resolveHints(@RequestParam(required = false) String domain) {
        List<OntologyType> types = (domain != null && !domain.isBlank())
                ? typeRepo.findByDomainOrderByLabelAsc(domain) : typeRepo.findAllByOrderByDomainAscLabelAsc();
        List<OntologyAction> actions = (domain != null && !domain.isBlank())
                ? actionRepo.findByDomainOrderByObjectTypeAsc(domain) : actionRepo.findAllByOrderByDomainAscObjectTypeAsc();
        return Map.of("types", types, "actions", actions);
    }

    // ===================== 对象引用（身份，非数据） =====================

    @GetMapping("/object-refs")
    public List<ObjectRef> listRefs(@RequestParam(required = false) String objectType) {
        if (objectType != null && !objectType.isBlank()) return refRepo.findByObjectTypeOrderByLastSeenAtDesc(objectType);
        return refRepo.findAllByOrderByLastSeenAtDesc();
    }

    /** 登记 / 更新对象引用（按 systemId + externalId 去重 upsert）。 */
    @PostMapping("/object-refs")
    public ObjectRef upsertRef(@RequestBody ObjectRef body) {
        ObjectRef existing = (body.getSystemId() != null && body.getExternalId() != null)
                ? refRepo.findBySystemIdAndExternalId(body.getSystemId(), body.getExternalId()) : null;
        if (existing != null) {
            if (body.getDisplayName() != null) existing.setDisplayName(body.getDisplayName());
            if (body.getObjectType() != null) existing.setObjectType(body.getObjectType());
            if (body.getCurrentState() != null) existing.setCurrentState(body.getCurrentState());
            if (body.getOwnerUserId() != null) existing.setOwnerUserId(body.getOwnerUserId());
            existing.setLastSeenAt(LocalDateTime.now());
            return refRepo.save(existing);
        }
        if (body.getId() == null || body.getId().isBlank()) body.setId("oref-" + UUID.randomUUID().toString().substring(0, 8));
        body.setLastSeenAt(LocalDateTime.now());
        body.setCreatedAt(LocalDateTime.now());
        return refRepo.save(body);
    }

    // ===================== 业务事件（Event Writer + 审计） =====================

    @GetMapping("/events")
    public List<BusinessEvent> listEvents(@RequestParam(required = false) String objectRefId) {
        if (objectRefId != null && !objectRefId.isBlank()) return eventRepo.findByObjectRefIdOrderByCreatedAtDesc(objectRefId);
        return eventRepo.findTop200ByOrderByCreatedAtDesc();
    }

    /** 记录一条业务事件（客户端执行动作后回写）。actor 优先取当前登录身份。 */
    @PostMapping("/events")
    public BusinessEvent recordEvent(@RequestBody BusinessEvent body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("oevt-" + UUID.randomUUID().toString().substring(0, 8));
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.getPrincipal() instanceof JwtAuthFilter.AuthPrincipal p) {
            if (body.getActorUserId() == null) body.setActorUserId(p.userId());
            if (body.getActorName() == null) body.setActorName(p.displayName());
        }
        body.setCreatedAt(LocalDateTime.now());
        return eventRepo.save(body);
    }
}
