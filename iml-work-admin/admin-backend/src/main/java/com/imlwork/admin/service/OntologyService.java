package com.imlwork.admin.service;

import com.imlwork.admin.model.BusinessEvent;
import com.imlwork.admin.model.ObjectRef;
import com.imlwork.admin.model.OntologyAction;
import com.imlwork.admin.model.OntologyType;
import com.imlwork.admin.repository.BusinessEventRepository;
import com.imlwork.admin.repository.ObjectRefRepository;
import com.imlwork.admin.repository.OntologyActionRepository;
import com.imlwork.admin.repository.OntologyTypeRepository;
import com.imlwork.admin.security.JwtAuthFilter;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 本体层领域服务：对象类型 / 动作的注册，对象引用 / 业务事件的登记。
 * 只存 Schema + 对象引用 + 业务事件，绝不存实例业务数据。
 */
@Service
public class OntologyService {

    private final OntologyTypeRepository typeRepo;
    private final OntologyActionRepository actionRepo;
    private final ObjectRefRepository refRepo;
    private final BusinessEventRepository eventRepo;

    public OntologyService(OntologyTypeRepository typeRepo, OntologyActionRepository actionRepo,
                           ObjectRefRepository refRepo, BusinessEventRepository eventRepo) {
        this.typeRepo = typeRepo;
        this.actionRepo = actionRepo;
        this.refRepo = refRepo;
        this.eventRepo = eventRepo;
    }

    // ── 对象类型 ──────────────────────────────────────────────────────────
    @Transactional(readOnly = true)
    public List<OntologyType> listTypes(String domain) {
        if (domain != null && !domain.isBlank()) return typeRepo.findByDomainOrderByLabelAsc(domain);
        return typeRepo.findAllByOrderByDomainAscLabelAsc();
    }

    @Transactional(readOnly = true)
    public OntologyType getType(String id) {
        return typeRepo.findById(id).orElseThrow(() -> notFound("对象类型不存在"));
    }

    @Transactional
    public OntologyType createType(OntologyType body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("otype-" + UUID.randomUUID().toString().substring(0, 8));
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return typeRepo.save(body);
    }

    @Transactional
    public OntologyType updateType(String id, OntologyType body) {
        OntologyType t = typeRepo.findById(id).orElseThrow(() -> notFound("对象类型不存在"));
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
        return typeRepo.save(t);
    }

    @Transactional
    public void deleteType(String id) {
        if (!typeRepo.existsById(id)) throw notFound("对象类型不存在");
        typeRepo.deleteById(id);
    }

    // ── 对象动作 ──────────────────────────────────────────────────────────
    @Transactional(readOnly = true)
    public List<OntologyAction> listActions(String domain, String objectType) {
        if (objectType != null && !objectType.isBlank()) return actionRepo.findByObjectTypeOrderByActionKeyAsc(objectType);
        if (domain != null && !domain.isBlank()) return actionRepo.findByDomainOrderByObjectTypeAsc(domain);
        return actionRepo.findAllByOrderByDomainAscObjectTypeAsc();
    }

    @Transactional(readOnly = true)
    public OntologyAction getAction(String id) {
        return actionRepo.findById(id).orElseThrow(() -> notFound("对象动作不存在"));
    }

    @Transactional
    public OntologyAction createAction(OntologyAction body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("oact-" + UUID.randomUUID().toString().substring(0, 8));
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return actionRepo.save(body);
    }

    @Transactional
    public OntologyAction updateAction(String id, OntologyAction body) {
        OntologyAction a = actionRepo.findById(id).orElseThrow(() -> notFound("对象动作不存在"));
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
        return actionRepo.save(a);
    }

    @Transactional
    public void deleteAction(String id) {
        if (!actionRepo.existsById(id)) throw notFound("对象动作不存在");
        actionRepo.deleteById(id);
    }

    // ── 解析提示 ──────────────────────────────────────────────────────────
    @Transactional(readOnly = true)
    public Map<String, Object> resolveHints(String domain) {
        List<OntologyType> types = (domain != null && !domain.isBlank())
                ? typeRepo.findByDomainOrderByLabelAsc(domain) : typeRepo.findAllByOrderByDomainAscLabelAsc();
        List<OntologyAction> actions = (domain != null && !domain.isBlank())
                ? actionRepo.findByDomainOrderByObjectTypeAsc(domain) : actionRepo.findAllByOrderByDomainAscObjectTypeAsc();
        return Map.of("types", types, "actions", actions);
    }

    // ── 对象引用（身份，非数据） ────────────────────────────────────────────
    @Transactional(readOnly = true)
    public List<ObjectRef> listRefs(String objectType) {
        if (objectType != null && !objectType.isBlank()) return refRepo.findByObjectTypeOrderByLastSeenAtDesc(objectType);
        return refRepo.findAllByOrderByLastSeenAtDesc();
    }

    /** 登记 / 更新对象引用（按 systemId + externalId 去重 upsert）。 */
    @Transactional
    public ObjectRef upsertRef(ObjectRef body) {
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

    // ── 业务事件 ──────────────────────────────────────────────────────────
    @Transactional(readOnly = true)
    public List<BusinessEvent> listEvents(String objectRefId) {
        if (objectRefId != null && !objectRefId.isBlank()) return eventRepo.findByObjectRefIdOrderByCreatedAtDesc(objectRefId);
        return eventRepo.findTop200ByOrderByCreatedAtDesc();
    }

    /** 记录业务事件；actor 缺省取当前登录身份。 */
    @Transactional
    public BusinessEvent recordEvent(BusinessEvent body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("oevt-" + UUID.randomUUID().toString().substring(0, 8));
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.getPrincipal() instanceof JwtAuthFilter.AuthPrincipal p) {
            if (body.getActorUserId() == null) body.setActorUserId(p.userId());
            if (body.getActorName() == null) body.setActorName(p.displayName());
        }
        body.setCreatedAt(LocalDateTime.now());
        return eventRepo.save(body);
    }

    private static ResponseStatusException notFound(String msg) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, msg);
    }
}
