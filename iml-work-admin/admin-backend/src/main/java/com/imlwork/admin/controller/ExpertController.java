package com.imlwork.admin.controller;

import com.imlwork.admin.model.Expert;
import com.imlwork.admin.model.Skill;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/experts")
public class ExpertController {

    private final List<Expert> experts = new ArrayList<>();

    public ExpertController() {
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
                - 华南区：酒店限额 450元/天，伙食补贴 80元/天.
                - 其他地区：酒店限额 300元/天，伙食补贴 60元/天。
                """;

        String sopWorkspaceAnalyzer = """
                # 本地工作空间文件分析 SOP
                
                ## 核心原则
                - 扫描本地工作目录中的物理文件，读取其物理尺寸、修改时间等元数据。
                - 查询本地缓存与云端同步标记，确定哪些文件未同步，生成表格报告。
                - 输出的报告中，文件名必须为 clickable local links 协议格式：[文件名](file:///绝对路径)。
                """;

        experts.add(new Expert("expert-1", "行政审批专员", 
                "行政事务申报及OA流程审批，支持表单自动填充与快捷催办", 
                "负责企业行政事务申报及OA流程审批。可以自动填充各类审批表单，获取审批链条状态，并支持通过飞书、微信等外部IM工具实现指令化快捷催办。",
                Arrays.asList(
                        new Skill("web-screenshot", "网页截图", "playwright", 
                                "网页离屏截图与保存技能，当用户要求对某个网页进行截图、查看网页视图、捕获页面或截图时使用。", 
                                Arrays.asList("截图", "screenshot", "网页截图", "截屏"), 
                                sopWebScreenshot, 
                                Arrays.asList("expert-1"))
                )
        ));
        
        experts.add(new Expert("expert-2", "财务报销核算员", 
                "差旅报销单据核验、发票合规审查及自动入账", 
                "负责差旅报销单据核验、发票合规审查及自动入账。熟悉企业财务与福利报销规范，可自动扫描发票OCR，比对合规风险，并模拟浏览器执行财务记账系统账目自动录入。",
                Arrays.asList(
                        new Skill("weather-check", "天气查询", "python-sandbox", 
                                "查询实时天气并进行出差标准合规性校验的技能。当用户提到天气、出差气候、weather 时触发。", 
                                Arrays.asList("天气", "weather", "气候", "出差天气"), 
                                sopWeatherCheck, 
                                Arrays.asList("expert-2"))
                )
        ));
        
        experts.add(new Expert("expert-3", "知识文档管理员", 
                "企业本地文件与云端数据库的分级管理、索引检索与同步", 
                "负责企业本地文件与云端数据库的分级管理与索引检索。监听本地工作目录，自动完成文档增量切片与向量化提取，提供本地大模型RAG私有知识库问答，并支持与企业云端数据的差量同步。",
                Arrays.asList(
                        new Skill("workspace-analyzer", "工作空间分析", "python-sandbox", 
                                "扫描本地个人空间物理目录、提取文件元数据并生成文件同步报告的技能。当用户要求分析文档、查看文件状态、扫描本地文件夹时触发。", 
                                Arrays.asList("分析文档", "分析文件", "分析本地", "分析空间", "扫描本地", "扫描文件"), 
                                sopWorkspaceAnalyzer, 
                                Arrays.asList("expert-3"))
                )
        ));
    }

    @GetMapping
    public ResponseEntity<List<Expert>> getAllExperts() {
        return ResponseEntity.ok(experts);
    }

    @PostMapping
    public ResponseEntity<Expert> createExpert(@RequestBody Expert expert) {
        if (expert.getId() == null || expert.getId().trim().isEmpty()) {
            expert.setId("expert-" + (experts.size() + 1));
        }
        experts.add(expert);
        return ResponseEntity.ok(expert);
    }

    @PostMapping("/claim/{id}")
    public ResponseEntity<Map<String, Object>> claimExpert(@PathVariable String id) {
        Expert found = experts.stream()
                .filter(e -> e.getId().equals(id))
                .findFirst()
                .orElse(null);

        if (found == null) {
            return ResponseEntity.notFound().build();
        }

        return ResponseEntity.ok(Map.of(
                "success", true,
                "expertId", found.getId(),
                "skillsSynced", found.getSkills()
        ));
    }
}
