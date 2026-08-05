package com.imlwork.admin.config;

import com.imlwork.admin.model.EnterpriseProfile;
import com.imlwork.admin.model.Expert;
import com.imlwork.admin.model.KnowledgeDocument;
import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.model.SandboxConfig;
import com.imlwork.admin.model.Skill;
import com.imlwork.admin.model.SyncFile;
import com.imlwork.admin.model.SystemIntegration;
import com.imlwork.admin.repository.ExpertRepository;
import com.imlwork.admin.repository.KnowledgeDocumentRepository;
import com.imlwork.admin.repository.EnterpriseProfileRepository;
import com.imlwork.admin.repository.ModelProviderRepository;
import com.imlwork.admin.repository.SandboxConfigRepository;
import com.imlwork.admin.repository.SkillRepository;
import com.imlwork.admin.repository.SyncFileRepository;
import com.imlwork.admin.repository.SystemIntegrationRepository;
import com.imlwork.admin.service.RagService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;
import java.util.Arrays;
import java.util.List;

/**
 * Seeds the demo corpus on first boot (when tables are empty), so the admin
 * console and the client harness have a realistic enterprise dataset. Idempotent:
 * skips any collection that already holds rows.
 */
@Component
public class DataSeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(DataSeeder.class);

    private final SkillRepository skillRepository;
    private final ExpertRepository expertRepository;
    private final KnowledgeDocumentRepository knowledgeRepository;
    private final SyncFileRepository syncFileRepository;
    private final SandboxConfigRepository sandboxConfigRepository;
    private final SystemIntegrationRepository integrationRepository;
    private final ModelProviderRepository modelProviderRepository;
    private final EnterpriseProfileRepository enterpriseProfileRepository;
    private final RagService ragService;
    private final boolean prod;

    public DataSeeder(SkillRepository skillRepository,
                      ExpertRepository expertRepository,
                      KnowledgeDocumentRepository knowledgeRepository,
                      SyncFileRepository syncFileRepository,
                      SandboxConfigRepository sandboxConfigRepository,
                      SystemIntegrationRepository integrationRepository,
                      ModelProviderRepository modelProviderRepository,
                      EnterpriseProfileRepository enterpriseProfileRepository,
                      RagService ragService,
                      @Value("${spring.profiles.active:}") String activeProfiles) {
        this.prod = activeProfiles != null && activeProfiles.contains("prod");
        this.skillRepository = skillRepository;
        this.expertRepository = expertRepository;
        this.knowledgeRepository = knowledgeRepository;
        this.syncFileRepository = syncFileRepository;
        this.sandboxConfigRepository = sandboxConfigRepository;
        this.integrationRepository = integrationRepository;
        this.modelProviderRepository = modelProviderRepository;
        this.enterpriseProfileRepository = enterpriseProfileRepository;
        this.ragService = ragService;
    }

    @Override
    public void run(String... args) {
        // 沙箱默认配置是功能性基础设施（超时/配额兜底），任何环境都要有一行。
        seedSandboxConfig();
        // 演示数据（示例岗位/技能/企业制度/假业务系统/无密钥模型通道）**仅限非 prod**：
        // 假制度会真实向量化进 RAG，客户环境员工问"报销标准"会命中演示企业的假答案——
        // 等于平台自己往知识库塞假业务数据（体检 P1-5）。与 AuthSeeder 演示账号同一纪律。
        if (prod) {
            log.info("[DataSeeder] prod 环境：跳过演示数据播种（岗位/技能/知识库/业务系统/模型通道/企业档案）。");
            return;
        }
        seedExpertsAndSkills();
        seedKnowledge();
        seedSyncFiles();
        seedIntegrations();
        seedModelProviders();
        seedEnterprise();
        // demo 审计追溯已停种——保持"干净的真实数据"环境，避免驾驶舱/审计里混入假执行记录。
    }

    private void seedEnterprise() {
        if (enterpriseProfileRepository.count() > 0) {
            return;
        }
        EnterpriseProfile p = new EnterpriseProfile();
        p.setId("default");
        p.setCompanyName("示例科技有限公司");
        p.setInfo("统一社会信用代码：91110108MA01XXXXXX。\n差旅报销规定：华东/华北区酒店限额 500元/天，伙食补贴 100元/天，超出需 VP 审批。");
        enterpriseProfileRepository.save(p);
        log.info("[Seeder] Seeded default enterprise profile.");
    }

    private void seedExpertsAndSkills() {
        if (expertRepository.count() > 0) {
            return;
        }
        // 预置技能由 BuiltinSkillSeeder（@Order(10)，先于本 Seeder）播种。
        // 这里只建一个演示岗位，把全部预置技能绑上：认领即可体验完整能力面。
        List<Skill> builtins = skillRepository.findByBuiltinTrue();
        if (builtins.isEmpty()) {
            log.warn("[Seeder] 未找到预置技能（seed/builtin-skills.json 未播种？），演示岗位以空技能创建。");
        }

        Expert e = new Expert("expert-1", "通用工作助理",
                "深度调研、数据分析、四类文档产出与图片视频生成的通用数字员工岗位",
                "面向全员的通用工作分身：能联网深度调研并产出结构化报告，获取 A 股行情做数据分析，"
                        + "生成与编辑 docx/pptx/xlsx/pdf 四类办公文档，按需生成图片与视频素材，"
                        + "还可以用 skill-creator 把重复性工作沉淀成新技能。",
                builtins);
        e.setKnowledgeCategories(Arrays.asList("公司基本信息", "行政财务制度", "企业合规制度"));
        e.setWebSearchEnabled(true);
        e.setOntologyDomains(Arrays.asList("OA", "CRM"));
        expertRepository.save(e);
        log.info("[Seeder] 已创建演示岗位「通用工作助理」，绑定 {} 个预置技能。", builtins.size());
    }

    private void seedKnowledge() {
        if (knowledgeRepository.count() > 0) {
            return;
        }
        log.info("[Seeder] Seeding corporate knowledge base + pgvector chunks...");

        try {
            seedDoc("corp-doc-1", "企业基础纳税识别规范.txt", "公司基本信息",
                    "公司全称：北京艾姆尔人工智能科技有限公司。纳税人识别号：91110108MA01XXXXXX。公司地址：北京市海淀区中关村南大街1号。主营业务为智能硬件设备制造及算法软件外包。");
            seedDoc("corp-doc-2", "企业差旅与福利报销规范.txt", "行政财务制度",
                    "公司差旅与福利报销规范：华东与华北区酒店限额500元每天，伙食补贴100元每天。华南区酒店限额450元每天。超出标准需要VP审批。机票默认经济舱，高铁默认二等座。");
            seedDoc("corp-doc-3", "公章申请审批细则.txt", "企业合规制度",
                    "公章申请审批细则：对外合同公章盖印需经法务评审通过后，由销售分管VP与人力VP会签。公章日常保管在行政前台保险箱，借用期限最长为2个工作日，必须在系统提前申请。");
        } catch (Exception e) {
            // 全新环境常常还没起向量服务（Ollama/bge-m3），向量化会抛错——演示知识库是锦上添花，
            // 不能拖死整个首启。跳过即可：向量服务就绪后重启会自动补种（表空时重试），或在管理端上传。
            log.warn("[Seeder] 演示知识库播种失败（多为向量服务未就绪），已跳过、不影响启动：{}", e.getMessage());
        }
    }

    private void seedDoc(String id, String filename, String category, String content) {
        int chunks = ragService.processAndAddDocument(id, category, content, 200, 30);
        KnowledgeDocument doc = new KnowledgeDocument(id, filename, content.getBytes().length, chunks, category,
                LocalDateTime.now().minusDays(1));
        doc.setChunkSize(200);
        doc.setChunkOverlap(30);
        doc.setScope("ENTERPRISE");   // 不设则为 NULL，会被 findByScope('ENTERPRISE') 漏掉（V5 已回填存量）
        knowledgeRepository.save(doc);
    }

    private void seedSyncFiles() {
        if (syncFileRepository.count() > 0) {
            return;
        }
        syncFileRepository.save(new SyncFile("2026_q2_sales_plan.pdf", "/documents/2026_q2_sales_plan.pdf",
                "Q2销售规划，目标拓展北方市场客户", true, 1024500L, "张经理 (销售部)"));
        syncFileRepository.save(new SyncFile("client_list_north.xlsx", "/documents/client_list_north.xlsx",
                "北方大区重点意向客户拜访名单与预算", true, 45200L, "张经理 (销售部)"));
    }

    private void seedSandboxConfig() {
        if (sandboxConfigRepository.count() > 0) {
            return;
        }
        sandboxConfigRepository.save(new SandboxConfig());
    }

    private void seedIntegrations() {
        if (integrationRepository.count() > 0) {
            return;
        }
        integrationRepository.save(new SystemIntegration("sys-oa", "OA", "泛微 OA 协同办公",
                "https://oa.imlwork.local", "rpa-bot", ""));
        integrationRepository.save(new SystemIntegration("sys-crm", "CRM", "销售云 CRM",
                "https://crm.imlwork.local", "rpa-bot", ""));
        integrationRepository.save(new SystemIntegration("sys-github", "GITHUB", "企业 GitHub Enterprise",
                "https://github.imlwork.local", "ci-bot", ""));
    }

    private void seedModelProviders() {
        if (modelProviderRepository.count() > 0) {
            return;
        }
        // Two providers share the "corp-default" route key → they form a weighted
        // load-balancing pool (3:1). A third is a local offline fallback. Keys are
        // left blank for demo; the admin fills them in the relay-station console.
        modelProviderRepository.save(new ModelProvider("mp-deepseek", "DeepSeek 主用通道", "DEEPSEEK",
                "https://api.deepseek.com/v1/chat/completions", "", "deepseek-chat", "corp-default", 3));
        modelProviderRepository.save(new ModelProvider("mp-openai", "OpenAI 备用通道", "OPENAI",
                "https://api.openai.com/v1/chat/completions", "", "gpt-4o-mini", "corp-default", 1));
        modelProviderRepository.save(new ModelProvider("mp-local", "本地 Ollama 离线通道", "OLLAMA",
                "http://localhost:11434/v1/chat/completions", "", "qwen2.5", "corp-local", 1));
        log.info("[Seeder] Seeded 3 demo model providers for the enterprise relay station.");
    }

}
