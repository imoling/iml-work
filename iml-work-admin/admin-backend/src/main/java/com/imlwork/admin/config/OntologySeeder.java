package com.imlwork.admin.config;

import com.imlwork.admin.model.OntologyAction;
import com.imlwork.admin.model.OntologyType;
import com.imlwork.admin.repository.OntologyActionRepository;
import com.imlwork.admin.repository.OntologyTypeRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 本体层演示 Seed：首启（表为空）时播种 OA 审批域 + CRM 商机域的对象类型与动作定义。
 *
 * OA 域绑 sys-oa，CRM 域绑 sys-crm（DataSeeder 已播种这两个业务系统）。
 * 只播种「定义」（Schema），不涉及任何实例业务数据。幂等：已有数据则跳过。
 */
@Component
@Order(20)
public class OntologySeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(OntologySeeder.class);

    private final OntologyTypeRepository typeRepo;
    private final OntologyActionRepository actionRepo;

    public OntologySeeder(OntologyTypeRepository typeRepo, OntologyActionRepository actionRepo) {
        this.typeRepo = typeRepo;
        this.actionRepo = actionRepo;
    }

    @Override
    public void run(String... args) {
        if (typeRepo.count() > 0 || actionRepo.count() > 0) return;
        seedOA();
        seedCRM();
        // 读驱动消解：对象列表页路径（客户端据此抓取候选对象再消解）
        setListPath("OA", "ApprovalTask", "/contract/list");
        setListPath("OA", "Contract", "/contract/list");
        setListPath("CRM", "Opportunity", "/crm/opportunities");
        log.info("[OntologySeeder] 已播种 OA + CRM 本体：{} 类型 / {} 动作", typeRepo.count(), actionRepo.count());
    }

    private void setListPath(String domain, String typeKey, String path) {
        OntologyType t = typeRepo.findByDomainAndTypeKey(domain, typeKey);
        if (t != null) { t.setResolveListPath(path); typeRepo.save(t); }
    }

    // ============================= OA 审批域 =============================
    private void seedOA() {
        String sys = "sys-oa";

        type("otype-oa-customer", "OA", "Customer", "客户", sys,
                "[{\"key\":\"name\",\"label\":\"客户名称\",\"type\":\"string\"},{\"key\":\"industry\",\"label\":\"行业\",\"type\":\"string\"}]",
                "[]", null, "审批链路里合同归属的客户。");

        type("otype-oa-contract", "OA", "Contract", "合同", sys,
                "[{\"key\":\"name\",\"label\":\"合同名称\",\"type\":\"string\"},{\"key\":\"amount\",\"label\":\"合同金额\",\"type\":\"number\"},{\"key\":\"customer\",\"label\":\"客户\",\"type\":\"ref\"}]",
                "[{\"name\":\"belongsTo\",\"targetType\":\"Customer\",\"cardinality\":\"one\"}]",
                "{\"initial\":\"draft\",\"states\":[\"draft\",\"pending\",\"approved\",\"rejected\"],\"transitions\":[{\"from\":\"pending\",\"to\":\"approved\",\"action\":\"approve\"},{\"from\":\"pending\",\"to\":\"rejected\",\"action\":\"reject\"}]}",
                "待审批的合同对象，带金额与客户关系。");

        type("otype-oa-approvaltask", "OA", "ApprovalTask", "审批任务", sys,
                "[{\"key\":\"title\",\"label\":\"标题\",\"type\":\"string\"},{\"key\":\"riskLevel\",\"label\":\"风险等级\",\"type\":\"enum\"}]",
                "[{\"name\":\"targets\",\"targetType\":\"Contract\",\"cardinality\":\"one\"}]",
                "{\"initial\":\"pending\",\"states\":[\"pending\",\"approved\",\"rejected\",\"riskFlagged\"],\"transitions\":[{\"from\":\"pending\",\"to\":\"approved\",\"action\":\"approve\"},{\"from\":\"pending\",\"to\":\"rejected\",\"action\":\"reject\"},{\"from\":\"pending\",\"to\":\"riskFlagged\",\"action\":\"markRisk\"}]}",
                "围绕合同的一次审批任务，是审批场景的主对象。");

        // 动作：评估风险（读，自动）
        action("oact-oa-evalrisk", "OA", "ApprovalTask", "evaluateRisk", "评估风险", "read",
                "pending", "pending", null,
                "{\"auto\":true,\"eventType\":\"RiskEvaluated\"}",
                "读取合同金额/条款做风险评估，不改状态。");
        // 动作：审批通过（写，金额>500万需人工确认）
        action("oact-oa-approve", "OA", "ApprovalTask", "approve", "审批通过", "update",
                "pending", "approved", null,
                "{\"auto\":true,\"confirmIf\":\"amount>5000000\",\"risk\":\"MEDIUM\",\"eventType\":\"ApprovalPassed\"}",
                "低风险直接通过；金额超 500 万强制人工确认（签名令牌）。");
        // 动作：标记风险（写，安全，自动）
        action("oact-oa-markrisk", "OA", "ApprovalTask", "markRisk", "标记风险", "update",
                "pending", "riskFlagged", null,
                "{\"auto\":true,\"risk\":\"HIGH\",\"eventType\":\"RiskFlagged\"}",
                "把有问题的审批任务标记为风险，转人工。");
        // 动作：驳回（写，始终人工确认）
        action("oact-oa-reject", "OA", "ApprovalTask", "reject", "驳回", "update",
                "pending", "rejected", null,
                "{\"auto\":false,\"confirmIf\":\"always\",\"eventType\":\"ApprovalRejected\"}",
                "驳回审批，属高影响写操作，始终需人工确认。");
    }

    // ============================= CRM 商机域（结合拜访记录） =============================
    private void seedCRM() {
        String sys = "sys-crm";

        type("otype-crm-customer", "CRM", "Customer", "客户", sys,
                "[{\"key\":\"name\",\"label\":\"客户名称\",\"type\":\"string\"},{\"key\":\"industry\",\"label\":\"行业\",\"type\":\"string\"},{\"key\":\"lastInteraction\",\"label\":\"最近互动\",\"type\":\"date\"}]",
                "[{\"name\":\"hasContact\",\"targetType\":\"Contact\",\"cardinality\":\"many\"},{\"name\":\"hasOpportunity\",\"targetType\":\"Opportunity\",\"cardinality\":\"many\"}]",
                null, "CRM 客户对象，聚合联系人与商机。");

        type("otype-crm-contact", "CRM", "Contact", "联系人", sys,
                "[{\"key\":\"name\",\"label\":\"姓名\",\"type\":\"string\"},{\"key\":\"title\",\"label\":\"职务\",\"type\":\"string\"},{\"key\":\"phone\",\"label\":\"电话\",\"type\":\"string\"}]",
                "[{\"name\":\"belongsTo\",\"targetType\":\"Customer\",\"cardinality\":\"one\"}]",
                null, "客户方联系人，如「宝钢李主任」。");

        type("otype-crm-opportunity", "CRM", "Opportunity", "商机", sys,
                "[{\"key\":\"name\",\"label\":\"商机名称\",\"type\":\"string\"},{\"key\":\"amount\",\"label\":\"金额\",\"type\":\"number\"},{\"key\":\"stage\",\"label\":\"阶段\",\"type\":\"enum\"}]",
                "[{\"name\":\"belongsTo\",\"targetType\":\"Customer\",\"cardinality\":\"one\"}]",
                "{\"initial\":\"lead\",\"states\":[\"lead\",\"proposal\",\"negotiation\",\"won\",\"lost\"],\"transitions\":[{\"from\":\"lead\",\"to\":\"proposal\",\"action\":\"advanceStage\"},{\"from\":\"proposal\",\"to\":\"negotiation\",\"action\":\"advanceStage\"},{\"from\":\"negotiation\",\"to\":\"won\",\"action\":\"markWon\"},{\"from\":\"*\",\"to\":\"lost\",\"action\":\"markLost\"}]}",
                "商机对象，阶段：线索→方案→谈判→赢单/输单（「方案阶段」=proposal）。");

        type("otype-crm-visitevent", "CRM", "VisitEvent", "拜访记录", sys,
                "[{\"key\":\"summary\",\"label\":\"拜访纪要\",\"type\":\"text\"},{\"key\":\"visitDate\",\"label\":\"拜访日期\",\"type\":\"date\"},{\"key\":\"contact\",\"label\":\"联系人\",\"type\":\"ref\"}]",
                "[{\"name\":\"withContact\",\"targetType\":\"Contact\",\"cardinality\":\"one\"},{\"name\":\"onCustomer\",\"targetType\":\"Customer\",\"cardinality\":\"one\"}]",
                null, "一次客户拜访事件，录入后关联联系人与客户。");

        // 动作：录入拜访记录（写·create，低风险自动）
        action("oact-crm-logvisit", "CRM", "VisitEvent", "logVisit", "录入拜访记录", "create",
                null, null, null,
                "{\"auto\":true,\"eventType\":\"VisitLogged\"}",
                "把一次拜访录入 CRM 并绑定客户/联系人。");
        // 动作：推进商机阶段（写·update，金额>500万需人工确认）
        action("oact-crm-advance", "CRM", "Opportunity", "advanceStage", "推进商机阶段", "update",
                null, null, null,
                "{\"auto\":true,\"confirmIf\":\"amount>5000000\",\"eventType\":\"StageAdvanced\"}",
                "把商机推进到下一阶段（如推进到「方案阶段」proposal）。");
        // 动作：赢单（写·update，始终人工确认）
        action("oact-crm-markwon", "CRM", "Opportunity", "markWon", "标记赢单", "update",
                "negotiation", "won", null,
                "{\"auto\":false,\"confirmIf\":\"always\",\"eventType\":\"OpportunityWon\"}",
                "把商机标记为赢单，高影响，始终需人工确认。");
        // 动作：更新客户最近互动（写·update，自动）
        action("oact-crm-touch", "CRM", "Customer", "touch", "更新最近互动", "update",
                null, null, null,
                "{\"auto\":true,\"eventType\":\"CustomerTouched\"}",
                "拜访/推进后自动刷新客户 lastInteraction。");
    }

    // ============================= helpers =============================
    private void type(String id, String domain, String typeKey, String label, String boundSystemId,
                      String propsJson, String relsJson, String stateJson, String desc) {
        OntologyType t = new OntologyType();
        t.setId(id);
        t.setDomain(domain);
        t.setTypeKey(typeKey);
        t.setLabel(label);
        t.setBoundSystemId(boundSystemId);
        t.setPropertiesJson(propsJson);
        t.setRelationsJson(relsJson);
        t.setStateMachineJson(stateJson);
        t.setDescription(desc);
        typeRepo.save(t);
    }

    private void action(String id, String domain, String objectType, String actionKey, String label,
                        String capability, String fromState, String toState, String connectorActionId,
                        String policyJson, String desc) {
        OntologyAction a = new OntologyAction();
        a.setId(id);
        a.setDomain(domain);
        a.setObjectType(objectType);
        a.setActionKey(actionKey);
        a.setLabel(label);
        a.setCapability(capability);
        a.setFromState(fromState);
        a.setToState(toState);
        a.setConnectorActionId(connectorActionId);
        a.setPolicyJson(policyJson);
        a.setDescription(desc);
        actionRepo.save(a);
    }
}
