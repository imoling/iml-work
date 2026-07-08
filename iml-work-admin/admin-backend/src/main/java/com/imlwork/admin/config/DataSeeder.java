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

    public DataSeeder(SkillRepository skillRepository,
                      ExpertRepository expertRepository,
                      KnowledgeDocumentRepository knowledgeRepository,
                      SyncFileRepository syncFileRepository,
                      SandboxConfigRepository sandboxConfigRepository,
                      SystemIntegrationRepository integrationRepository,
                      ModelProviderRepository modelProviderRepository,
                      EnterpriseProfileRepository enterpriseProfileRepository,
                      RagService ragService) {
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
        seedExpertsAndSkills();
        seedKnowledge();
        seedSyncFiles();
        seedSandboxConfig();
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
        log.info("[Seeder] Seeding experts, skills and bindings...");

        String sopWebScreenshot = """
                # 网页截图技能 SOP

                ## 核心原则
                - 接收用户提供的 URL 地址。如果用户未指定具体 URL，将自动使用默认网址。
                - 启动本地静默渲染引擎，载入该网页视图，并捕捉页面快照。
                - 将生成的物理图片保存到本地个人文件空间，并返回 HTML/Markdown 图片占位符。

                ## 使用指导
                - 在回复中向用户确认网页截图已成功保存到本地。
                - 必须包含占位符 [IMAGE_PLACEHOLDER_PNG] 以便前端加载图像。
                """;

        String sopWeatherCheck = """
                # 天气与差旅标准校验 SOP

                ## 核心原则
                - 识别用户出差的目的地城市。
                - 向天气接口发起网络查询，获取实时温度和气象。
                - 将目标城市与艾姆尔公司《差旅报销管理规范》标准进行对比，输出酒店及伙食补贴限额判断。

                ## 差旅标准参考
                - 华东/华北区：酒店限额 500元/天，伙食补贴 100元/天。
                - 华南区：酒店限额 450元/天，伙食补贴 80元/天。
                - 其他地区：酒店限额 300元/天，伙食补贴 60元/天。
                """;

        String sopWorkspaceAnalyzer = """
                # 本地工作空间文件分析 SOP

                ## 核心原则
                - 扫描本地工作目录中的物理文件，读取其物理尺寸、修改时间等元数据。
                - 查询本地缓存与云端同步标记，确定哪些文件未同步，生成表格报告。
                - 输出的报告中，文件名必须为 clickable local links 协议格式：[文件名](file:///绝对路径)。
                """;

        Skill webScreenshot = new Skill("web-screenshot", "网页截图", "playwright",
                "网页离屏截图与保存技能，当用户要求对某个网页进行截图、查看网页视图、捕获页面或截图时使用。",
                Arrays.asList("截图", "screenshot", "网页截图", "截屏"),
                sopWebScreenshot, Arrays.asList("expert-1"));
        Skill weatherCheck = new Skill("weather-check", "天气查询", "python-sandbox",
                "查询实时天气并进行出差标准合规性校验的技能。当用户提到天气、出差气候、weather 时触发。",
                Arrays.asList("天气", "weather", "气候", "出差天气"),
                sopWeatherCheck, Arrays.asList("expert-2"));
        Skill workspaceAnalyzer = new Skill("workspace-analyzer", "工作空间分析", "python-sandbox",
                "扫描本地个人空间物理目录、提取文件元数据并生成文件同步报告的技能。当用户要求分析文档、查看文件状态、扫描本地文件夹时触发。",
                Arrays.asList("分析文档", "分析文件", "分析本地", "分析空间", "扫描本地", "扫描文件"),
                sopWorkspaceAnalyzer, Arrays.asList("expert-3"));

        webScreenshot.setCategory("办公自动化");
        weatherCheck.setCategory("财务税务");
        workspaceAnalyzer.setCategory("知识管理");
        for (Skill s : List.of(webScreenshot, weatherCheck, workspaceAnalyzer)) {
            s.setStatus("PUBLISHED");
            s.setVersion("1.0.0");
        }

        skillRepository.saveAll(List.of(webScreenshot, weatherCheck, workspaceAnalyzer));

        Expert e1 = new Expert("expert-1", "行政审批专员",
                "行政事务申报及OA流程审批，支持表单自动填充与快捷催办",
                "负责企业行政事务申报及OA流程审批。可以自动填充各类审批表单，获取审批链条状态，并支持通过飞书、微信等外部IM工具实现指令化快捷催办。",
                List.of(webScreenshot));
        e1.setKnowledgeCategories(Arrays.asList("企业合规制度", "行政财务制度"));

        Expert e2 = new Expert("expert-2", "财务报销核算员",
                "差旅报销单据核验、发票合规审查及自动入账",
                "负责差旅报销单据核验、发票合规审查及自动入账。熟悉企业财务与福利报销规范，可自动扫描发票OCR，比对合规风险，并模拟浏览器执行财务记账系统账目自动录入。",
                List.of(weatherCheck));
        e2.setKnowledgeCategories(Arrays.asList("行政财务制度", "公司基本信息"));

        Expert e3 = new Expert("expert-3", "知识文档管理员",
                "企业本地文件与云端数据库的分级管理、索引检索与同步",
                "负责企业本地文件与云端数据库的分级管理与索引检索。监听本地工作目录，自动完成文档增量切片与向量化提取，提供本地大模型RAG私有知识库问答，并支持与企业云端数据的差量同步。",
                List.of(workspaceAnalyzer));
        e3.setKnowledgeCategories(Arrays.asList("公司基本信息", "企业合规制度", "人事审批规范"));

        expertRepository.saveAll(List.of(e1, e2, e3));
    }

    private void seedKnowledge() {
        if (knowledgeRepository.count() > 0) {
            return;
        }
        log.info("[Seeder] Seeding corporate knowledge base + pgvector chunks...");

        seedDoc("corp-doc-1", "企业基础纳税识别规范.txt", "公司基本信息",
                "公司全称：北京艾姆尔人工智能科技有限公司。纳税人识别号：91110108MA01XXXXXX。公司地址：北京市海淀区中关村南大街1号。主营业务为智能硬件设备制造及算法软件外包。");
        seedDoc("corp-doc-2", "企业差旅与福利报销规范.txt", "行政财务制度",
                "公司差旅与福利报销规范：华东与华北区酒店限额500元每天，伙食补贴100元每天。华南区酒店限额450元每天。超出标准需要VP审批。机票默认经济舱，高铁默认二等座。");
        seedDoc("corp-doc-3", "公章申请审批细则.txt", "企业合规制度",
                "公章申请审批细则：对外合同公章盖印需经法务评审通过后，由销售分管VP与人力VP会签。公章日常保管在行政前台保险箱，借用期限最长为2个工作日，必须在系统提前申请。");
    }

    private void seedDoc(String id, String filename, String category, String content) {
        int chunks = ragService.processAndAddDocument(id, category, content, 200, 30);
        KnowledgeDocument doc = new KnowledgeDocument(id, filename, content.getBytes().length, chunks, category,
                LocalDateTime.now().minusDays(1));
        doc.setChunkSize(200);
        doc.setChunkOverlap(30);
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
