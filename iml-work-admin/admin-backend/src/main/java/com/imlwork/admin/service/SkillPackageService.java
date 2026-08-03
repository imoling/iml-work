package com.imlwork.admin.service;

import com.imlwork.admin.model.Skill;
import com.imlwork.admin.repository.SkillRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * 技能**包**管线（从 SkillService 拆出——体检 B4 结构债：原文件 1258 行，这条链约占 450 行且边界清晰）：
 * 解析（zip/SKILL.md/JSON 包）→ 安全扫描裁决（HIGH 阻断 / REVIEW 人工复核）→ 落库安装，
 * 以及导出（便携 JSON / zip 目录）与 GitHub 目录抓取。
 *
 * 依赖单向：SkillService → SkillPackageService → {SkillRepository, SkillSecurityService, SkillLlmHelper}。
 * 触发词派生走 SkillLlmHelper（叶子）——它同时被 SkillService 用，放这里或那里都会成环，故独立成叶子。
 */
@Service
public class SkillPackageService {

    private final SkillRepository skillRepository;
    private final SkillSecurityService security;
    private final SkillLlmHelper llm;
    private final ObjectMapper mapper = new ObjectMapper();

    public SkillPackageService(SkillRepository skillRepository, SkillSecurityService security, SkillLlmHelper llm) {
        this.skillRepository = skillRepository;
        this.security = security;
        this.llm = llm;
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "技能不存在");
    }

    private String[] readZip(byte[] bytes) throws Exception {
        String md = null;
        String code = null;
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = entry.getName().toLowerCase();
                String content = new String(zis.readAllBytes(), StandardCharsets.UTF_8);
                if (name.endsWith(".md")) md = content;
                else if (name.endsWith(".js") || name.endsWith(".ts") || name.endsWith(".py")) code = content;
            }
        }
        return new String[]{md, code};
    }

    /** 行首空格数（YAML 块标量判边界用）。 */
    private static int indentOf(String line) {
        int n = 0;
        while (n < line.length() && line.charAt(n) == ' ') n++;
        return n;
    }

    /** 包级可见：SKILL.md frontmatter 解析是纯逻辑，值得直接单测（块标量那类坑靠端到端很难覆盖）。 */
    Skill parseSkillMarkdown(String content) {
        Skill skill = new Skill();
        skill.setSource("upload-md");
        String body = content;
        String frontmatter = "";
        String trimmed = content.stripLeading();
        if (trimmed.startsWith("---")) {
            int end = trimmed.indexOf("\n---", 3);
            if (end > 0) {
                frontmatter = trimmed.substring(3, end);
                body = trimmed.substring(end + 4).stripLeading();
            }
        }
        List<String> triggers = new ArrayList<>();
        List<String> roles = new ArrayList<>();
        String currentList = null;
        String[] lines = frontmatter.split("\n");
        for (int i = 0; i < lines.length; i++) {
            String rawLine = lines[i].replace("\t", "  ");
            String t = rawLine.trim();
            if (t.isEmpty()) continue;
            if (t.startsWith("- ")) {
                String item = t.substring(2).trim().replaceAll("^['\"]|['\"]$", "");
                if ("trigger_keywords".equals(currentList)) triggers.add(item);
                else if ("allowed_roles".equals(currentList)) roles.add(item);
                continue;
            }
            int colon = t.indexOf(':');
            if (colon < 0) continue;
            String key = t.substring(0, colon).trim();
            String value = t.substring(colon + 1).trim().replaceAll("^['\"]|['\"]$", "");
            // YAML 块标量（description: | 或 >，可带 -/+ 裁剪符）——多行描述在第三方 SKILL.md 里很常见。
            // 不认它的话取到的字面值就是一个 "|"，而 description 正是语义路由的判据，
            // 等于这个技能永远路由不对（实测：装 Humanizer-zh 时 description 就是 "|"）。
            if (value.matches("^[|>][-+]?$")) {
                boolean literal = value.charAt(0) == '|';   // | 保留换行；> 折叠成空格
                int baseIndent = indentOf(rawLine);
                StringBuilder sb = new StringBuilder();
                int j = i + 1;
                for (; j < lines.length; j++) {
                    String l = lines[j].replace("\t", "  ");
                    if (l.trim().isEmpty()) { if (sb.length() > 0) sb.append("\n"); continue; }
                    if (indentOf(l) <= baseIndent) break;      // 缩进退回 → 块结束
                    if (sb.length() > 0 && sb.charAt(sb.length() - 1) != '\n') sb.append(literal ? "\n" : " ");
                    sb.append(l.trim());
                }
                i = j - 1;
                value = sb.toString().trim();
            }
            switch (key) {
                case "name" -> { skill.setName(value); skill.setId(value); currentList = null; }
                case "description" -> { skill.setDescription(value); currentList = null; }
                case "type" -> { skill.setType(value); currentList = null; }
                case "category" -> { skill.setCategory(value); currentList = null; }
                case "version" -> { skill.setVersion(value); currentList = null; }
                case "target_system" -> { skill.setTargetSystemId(value); currentList = null; }
                case "trigger_keywords" -> currentList = "trigger_keywords";
                case "allowed_roles" -> currentList = "allowed_roles";
                default -> currentList = null;
            }
        }
        skill.setTriggerKeywords(triggers);
        skill.setAllowedRoles(roles);
        skill.setSopContent(body);
        // 无显式 type 的裸 SKILL.md 本质是「知识/指南型」——不含可执行代码、由模型按 SOP 应用（如 brand-guidelines）。
        // 带代码(zip)或目录含脚本的会在调用方提升为 python-sandbox。
        if (skill.getType() == null) skill.setType("knowledge");
        return skill;
    }

    /** 目录技能按 bundle 内是否含可执行脚本判定引擎类型：有 .py/.js/.ts → 沙箱执行(python-sandbox)；纯 SKILL.md+参考资料 → 知识/指南型。 */
    private String deriveTypeFromBundle(Map<String, String> bundle) {
        boolean hasScript = bundle.keySet().stream().anyMatch(k -> {
            String lk = k.toLowerCase();
            return !lk.equals("skill.md") && (lk.endsWith(".py") || lk.endsWith(".js") || lk.endsWith(".ts"));
        });
        return hasScript ? "python-sandbox" : "knowledge";
    }

    // ════════════ 技能包导出 / 安装（GitHub·本地包）+ 导入前安全检查 ════════════

    /** 便携技能包字段：剥离本地环境绑定（targetSystemId 各环境不同，导入后需重新绑定）。 */
    private Map<String, Object> portable(Skill s) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("originId", s.getId());
        m.put("name", s.getName());
        m.put("type", s.getType());
        m.put("category", s.getCategory());
        m.put("version", s.getVersion());
        m.put("description", s.getDescription());
        m.put("triggerKeywords", s.getTriggerKeywords());
        m.put("sopContent", s.getSopContent());
        m.put("code", s.getCode());
        m.put("allowedRoles", s.getAllowedRoles());
        m.put("actionScript", s.getActionScript());
        m.put("skillKind", s.getSkillKind());
        m.put("navHash", s.getNavHash());
        // bundle = 技能的**整个目录**（SKILL.md + 脚本 + 参考资料）。此前导出漏了它——
        // 导出的包只有元数据，脚本和参考文件全丢，导进去就是个空壳技能，跑不起来。
        // 以**对象**形态导出（而非转义过的 JSON 字符串），包可读、也便于人工审核脚本内容。
        if (s.getBundle() != null && !s.getBundle().isBlank()) {
            try {
                m.put("bundle", mapper.readValue(s.getBundle(),
                        new com.fasterxml.jackson.core.type.TypeReference<Map<String, String>>() {}));
            } catch (Exception ignored) { m.put("bundle", s.getBundle()); }   // 非法 JSON → 原样带出，不丢
        }
        return m;
    }

    private Map<String, Object> envelope(List<Skill> skills) {
        Map<String, Object> pkg = new LinkedHashMap<>();
        pkg.put("format", "iml-skill-package");
        pkg.put("formatVersion", 1);
        pkg.put("exportedAt", LocalDateTime.now().toString());
        pkg.put("skills", skills.stream().map(this::portable).toList());
        return pkg;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> exportOne(String id) {
        Skill s = skillRepository.findById(id).orElseThrow(SkillPackageService::notFound);
        return envelope(List.of(s));
    }

    /**
     * 导出为**真正的技能包**（zip 目录），而不是一坨 JSON。
     *
     * 为什么：技能包的通用形态就是一个目录（SKILL.md + scripts/ + 参考资料）——能直接看、直接改、
     * 直接给别人、也能被别的工具认。此前只导出 JSON 信封：即便把 bundle 塞进去，拿到手也是个
     * 166KB 的 blob，脚本读不了、改不了。而且**导入认 zip、导出吐 json**，本身就不对称。
     *
     * 包内结构：
     *   SKILL.md            —— 技能说明（bundle 里没有就按 sopContent 生成，保证导回去能认）
     *   scripts/…、*.md     —— bundle 里的原始文件，原样铺开
     *   iml-skill.json      —— iML 专有元数据（触发词/录制脚本/引擎类型/直达路由…），
     *                          纯 SKILL.md 装不下这些，丢了技能就跑不起来。导入时会读回。
     */
    @Transactional(readOnly = true)
    public byte[] exportZip(String id) {
        Skill s = skillRepository.findById(id).orElseThrow(SkillPackageService::notFound);
        Map<String, String> files = new LinkedHashMap<>();
        if (s.getBundle() != null && !s.getBundle().isBlank()) {
            try {
                files.putAll(mapper.readValue(s.getBundle(),
                        new com.fasterxml.jackson.core.type.TypeReference<Map<String, String>>() {}));
            } catch (Exception ignored) { /* bundle 非法 JSON → 按无 bundle 处理，下面会生成 SKILL.md */ }
        }
        // 没有 SKILL.md（录制类技能就没有）→ 用技能元数据生成一份，否则导回去会被判"技能包内没有 SKILL.md"
        boolean hasMd = files.keySet().stream().anyMatch(k -> k.equalsIgnoreCase("SKILL.md"));
        if (!hasMd) files.put("SKILL.md", renderSkillMarkdown(s));

        // iML 专有元数据：SKILL.md 的 frontmatter 装不下录制脚本/直达路由/引擎类型，单独落一个文件
        Map<String, Object> meta = portable(s);
        meta.remove("bundle");   // 文件已经铺开在 zip 里了，不必再塞一份
        try { files.put("iml-skill.json", mapper.writerWithDefaultPrettyPrinter().writeValueAsString(meta)); }
        catch (Exception e) { throw new IllegalStateException("元数据序列化失败", e); }

        String root = safeDirName(s.getName(), s.getId());
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        try (java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(bos)) {
            for (Map.Entry<String, String> e : files.entrySet()) {
                zos.putNextEntry(new java.util.zip.ZipEntry(root + "/" + e.getKey()));
                zos.write(e.getValue().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                zos.closeEntry();
            }
        } catch (Exception e) { throw new IllegalStateException("技能包打包失败：" + e.getMessage(), e); }
        return bos.toByteArray();
    }

    /** 技能名 → 安全的目录名（去掉路径分隔符与空白；空则退回 id）。 */
    private static String safeDirName(String name, String id) {
        String n = (name == null ? "" : name).trim().replaceAll("[\\\\/:*?\"<>|\\s]+", "-");
        return n.isBlank() ? id : n;
    }

    /** 无 bundle 的技能（如录制类）→ 生成一份 SKILL.md，让导出的包仍是合法技能包。 */
    private static String renderSkillMarkdown(Skill s) {
        StringBuilder b = new StringBuilder();
        b.append("---\n");
        b.append("name: ").append(s.getName() == null ? "" : s.getName()).append("\n");
        if (s.getDescription() != null && !s.getDescription().isBlank())
            b.append("description: ").append(s.getDescription().replace("\n", " ")).append("\n");
        b.append("---\n\n");
        b.append("# ").append(s.getName() == null ? "" : s.getName()).append("\n\n");
        if (s.getDescription() != null && !s.getDescription().isBlank())
            b.append(s.getDescription()).append("\n\n");
        if (s.getSopContent() != null && !s.getSopContent().isBlank())
            b.append(s.getSopContent()).append("\n");
        return b.toString();
    }

    @Transactional(readOnly = true)
    public Map<String, Object> exportAll() {
        return envelope(skillRepository.findAll());
    }

    /** GitHub 域名白名单（防 SSRF：安装端点绝不允许指向任意地址/内网）。 */
    private static final Set<String> GITHUB_HOSTS = Set.of(
            "github.com", "raw.githubusercontent.com", "gist.github.com", "gist.githubusercontent.com", "api.github.com");
    /** 只收录文本类文件进 bundle（二进制/模板/图片跳过，避免撑爆库且无扫描意义）。 */
    private static final Set<String> TEXT_EXT = Set.of(
            "py","md","txt","json","js","mjs","cjs","ts","sh","bash","yaml","yml","toml","cfg","ini","csv","xml","html","htm","css","rst");
    private static final int MAX_BUNDLE_FILES = 60;
    private static final int MAX_BUNDLE_BYTES = 3_000_000;

    /** github.com 的 blob 页面地址自动转 raw 直链。 */
    private static String toRawUrl(String url) {
        // https://github.com/{owner}/{repo}/blob/{ref}/{path} → raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^https://github\\.com/([^/]+)/([^/]+)/blob/(.+)$").matcher(url);
        if (m.matches()) return "https://raw.githubusercontent.com/" + m.group(1) + "/" + m.group(2) + "/" + m.group(3);
        return url;
    }

    private final java.net.http.HttpClient ghHttp = java.net.http.HttpClient.newBuilder()
            .connectTimeout(java.time.Duration.ofSeconds(10))
            .followRedirects(java.net.http.HttpClient.Redirect.NORMAL)
            .proxy(java.net.ProxySelector.getDefault())
            .build();

    /** GitHub 域名内的 GET（防 SSRF：仅白名单主机；带上限）。 */
    private byte[] ghGet(String url, int maxBytes) {
        if (url == null || !url.startsWith("https://")) throw new IllegalArgumentException("仅支持 https 的 GitHub 地址");
        String host;
        try { host = java.net.URI.create(url).getHost(); } catch (Exception e) { throw new IllegalArgumentException("地址无效"); }
        if (host == null || !GITHUB_HOSTS.contains(host.toLowerCase()))
            throw new IllegalArgumentException("仅允许 GitHub 域名——防止内网探测");
        try {
            java.net.http.HttpRequest.Builder b = java.net.http.HttpRequest.newBuilder(java.net.URI.create(url))
                    .timeout(java.time.Duration.ofSeconds(30)).header("User-Agent", "iml-work").GET();
            java.net.http.HttpResponse<byte[]> res = ghHttp.send(b.build(), java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            if (res.statusCode() / 100 != 2) throw new IllegalArgumentException("GitHub 请求失败 HTTP " + res.statusCode()
                    + (res.statusCode() == 403 ? "（可能触发匿名 API 限流，稍后重试）" : ""));
            if (res.body().length > maxBytes) throw new IllegalArgumentException("内容超过上限 " + (maxBytes / 1_000_000) + "MB");
            return res.body();
        } catch (IllegalArgumentException e) { throw e; }
        catch (Exception e) { throw new IllegalArgumentException("下载失败：" + e.getMessage()); }
    }

    /** 单文件下载（JSON 包 / 单 SKILL.md），2MB 上限。 */
    public String downloadFromGithub(String url) {
        return new String(ghGet(toRawUrl(url.trim()), 2_000_000), StandardCharsets.UTF_8);
    }

    private record GhLoc(String owner, String repo, String ref, String dir) {}

    /** 解析 GitHub 目录/文件地址；返回技能目录（blob/…/SKILL.md → 其父目录；tree/…/dir → 该目录）。非目录返回 null。 */
    private GhLoc resolveSkillDir(String url) {
        String u = url.trim();
        // ① 裸仓库地址（https://github.com/owner/repo，可带 .git 或结尾斜杠）→ 默认分支的仓库根目录。
        //    多数第三方技能就是"一个仓库 = 一个技能"，用户和模型给出的也正是这个地址。
        //    不认它的话会掉进下面的单文件解析路径，报一句"SKILL.md 缺少 name 字段"——
        //    错得让人完全找不到北（实测：装 Humanizer-zh 时踩到）。
        java.util.regex.Matcher repo = java.util.regex.Pattern
                .compile("^https://github\\.com/([^/]+)/([^/]+?)(?:\\.git)?/?$").matcher(u);
        if (repo.matches()) {
            return new GhLoc(repo.group(1), repo.group(2), defaultBranch(repo.group(1), repo.group(2)), "");
        }
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^https://github\\.com/([^/]+)/([^/]+)/(blob|tree)/([^/]+)/(.+)$").matcher(url.trim());
        if (!m.matches()) return null;
        String path = m.group(5);
        if ("blob".equals(m.group(3))) {
            if (!path.toLowerCase().endsWith("/skill.md") && !path.equalsIgnoreCase("skill.md")) return null; // 单文件(非 SKILL.md)走原逻辑
            int slash = path.lastIndexOf('/');
            path = slash > 0 ? path.substring(0, slash) : "";
        }
        return new GhLoc(m.group(1), m.group(2), m.group(4), path);
    }

    /** 仓库默认分支。查不到就退回 main——比硬报错强，真错了下一步抓目录时会报"目录内未找到 SKILL.md"。 */
    private String defaultBranch(String owner, String repo) {
        try {
            com.fasterxml.jackson.databind.JsonNode n = mapper.readTree(
                    new String(ghGet("https://api.github.com/repos/" + owner + "/" + repo, 200_000), StandardCharsets.UTF_8));
            String b = n.path("default_branch").asText("");
            if (!b.isBlank()) return b;
        } catch (Exception e) {
            // 取不到不是致命的（网络抖动/私有仓库），退回 main；真错了下一步抓目录会给出明确的错
            System.err.println("[SkillPackage] 取默认分支失败 " + owner + "/" + repo + "：" + e.getMessage());
        }
        return "main";
    }

    /** 递归抓取技能目录下的文本文件（相对目录的路径 → 内容）；二进制/超限跳过。 */
    private Map<String, String> fetchGithubBundle(GhLoc loc) {
        Map<String, String> files = new LinkedHashMap<>();
        int[] total = {0};
        crawl(loc, loc.dir(), "", files, total);
        if (files.keySet().stream().noneMatch(k -> k.equalsIgnoreCase("SKILL.md")))
            throw new IllegalArgumentException("目录内未找到 SKILL.md");
        return files;
    }

    private void crawl(GhLoc loc, String apiPath, String rel, Map<String, String> out, int[] total) {
        if (out.size() >= MAX_BUNDLE_FILES || total[0] >= MAX_BUNDLE_BYTES) return;
        String api = "https://api.github.com/repos/" + loc.owner() + "/" + loc.repo()
                + "/contents/" + apiPath + "?ref=" + loc.ref();
        try {
            com.fasterxml.jackson.databind.JsonNode arr = mapper.readTree(new String(ghGet(api, 1_000_000), StandardCharsets.UTF_8));
            if (!arr.isArray()) return;
            for (com.fasterxml.jackson.databind.JsonNode n : arr) {
                if (out.size() >= MAX_BUNDLE_FILES || total[0] >= MAX_BUNDLE_BYTES) break;
                String name = n.path("name").asText(), type = n.path("type").asText();
                String childRel = rel.isEmpty() ? name : rel + "/" + name;
                if ("dir".equals(type)) {
                    crawl(loc, apiPath + "/" + name, childRel, out, total);
                } else if ("file".equals(type)) {
                    String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
                    long size = n.path("size").asLong(0);
                    if (!TEXT_EXT.contains(ext)) continue;              // 跳过二进制/模板/图片
                    if (size > 500_000) continue;                       // 跳过异常大文件
                    String dl = n.path("download_url").asText("");
                    if (dl.isBlank()) continue;
                    String content = new String(ghGet(dl, 500_000), StandardCharsets.UTF_8);
                    out.put(childRel, content);
                    total[0] += content.length();
                }
            }
        } catch (IllegalArgumentException e) { throw e; }
        catch (Exception e) { throw new IllegalArgumentException("读取目录失败：" + e.getMessage()); }
    }

    /** 解析技能包：自动识别 iML JSON 包 / 通用 SKILL.md(YAML frontmatter+Markdown) 两种格式。 */
    private List<Skill> parsePackage(String raw) {
        if (raw == null || raw.isBlank()) throw new IllegalArgumentException("技能包内容为空");
        String head = raw.stripLeading();
        // 非 JSON 起始({/[) → 当作 SKILL.md 解析(复用上传解析器);GitHub 上多为此格式
        if (!head.startsWith("{") && !head.startsWith("[")) {
            Skill s = parseSkillMarkdown(raw);
            if (s.getName() == null || s.getName().isBlank())
                throw new IllegalArgumentException("SKILL.md 缺少 name 字段（frontmatter 内 name:）");
            llm.ensureTriggerKeywords(s);   // 外源 SKILL.md 无 trigger_keywords → 自动派生
            s.setId("skill-imp-" + UUID.randomUUID().toString().substring(0, 8));
            s.setStatus("DRAFT");
            s.setSource("imported");
            s.setUpdatedAt(LocalDateTime.now());
            // 裸 SKILL.md 也落 bundle（{"SKILL.md": 原文}）：python-sandbox/knowledge 的 agentic 执行
            // 从 bundle 取手册。此前只存 sopContent，客户端 agentic 分支因 bundle 为空整个进不去
            //（真实事故：a-stock-data 单文件技能装完路由选中也不执行）。
            try { s.setBundle(mapper.writeValueAsString(Map.of("SKILL.md", raw))); } catch (Exception ignore) { /* 序列化失败不阻断，退化为纯 SOP */ }
            return new ArrayList<>(List.of(s));
        }
        return parseJsonPackage(raw);
    }

    /** 解析 iML JSON 包（信封 / 单技能 / 数组三种形态），转为待装 Skill 列表（未落库）。 */
    private List<Skill> parseJsonPackage(String json) {
        try {
            com.fasterxml.jackson.databind.JsonNode root = mapper.readTree(json);
            com.fasterxml.jackson.databind.JsonNode arr =
                    root.has("skills") ? root.get("skills") : (root.isArray() ? root : mapper.createArrayNode().add(root));
            List<Skill> out = new ArrayList<>();
            for (com.fasterxml.jackson.databind.JsonNode n : arr) {
                Skill s = new Skill();
                s.setId("skill-imp-" + UUID.randomUUID().toString().substring(0, 8));
                s.setName(n.path("name").asText(""));
                if (s.getName().isBlank()) throw new IllegalArgumentException("技能缺少 name 字段");
                s.setType(n.path("type").asText("playwright"));
                s.setCategory(n.path("category").asText("导入技能"));
                s.setVersion(n.path("version").asText("1.0.0"));
                s.setDescription(n.path("description").asText(""));
                s.setSopContent(n.path("sopContent").asText(""));
                s.setCode(n.path("code").asText(""));
                s.setActionScript(n.path("actionScript").asText(""));
                s.setSkillKind(n.path("skillKind").asText(""));
                s.setNavHash(n.path("navHash").asText(""));
                // bundle：导出时是对象、手写包里也可能是字符串——两种都收，否则脚本目录悄悄丢失。
                com.fasterxml.jackson.databind.JsonNode bn = n.path("bundle");
                if (bn.isObject()) {
                    try { s.setBundle(mapper.writeValueAsString(bn)); } catch (Exception ignored) { /* 序列化失败则不带 bundle */ }
                } else if (bn.isTextual() && !bn.asText().isBlank()) {
                    s.setBundle(bn.asText());
                }
                List<String> kws = new ArrayList<>();
                n.path("triggerKeywords").forEach(k -> kws.add(k.asText()));
                s.setTriggerKeywords(kws);
                List<String> roles = new ArrayList<>();
                n.path("allowedRoles").forEach(r -> roles.add(r.asText()));
                s.setAllowedRoles(roles);
                // 安全默认：导入即 DRAFT（人工审核后再上架）；外源系统绑定清空
                s.setStatus("DRAFT");
                s.setSource("imported");
                if (n.has("targetSystemId") && !n.path("targetSystemId").asText("").isBlank()) {
                    s.setTargetSystemId(n.path("targetSystemId").asText());   // 保留原值供扫描器报出，落库前清空
                }
                s.setUpdatedAt(LocalDateTime.now());
                out.add(s);
            }
            if (out.isEmpty()) throw new IllegalArgumentException("包内没有技能");
            if (out.size() > 50) throw new IllegalArgumentException("单包技能数超过 50 上限");
            return out;
        } catch (IllegalArgumentException e) { throw e; }
        catch (Exception e) { throw new IllegalArgumentException("技能包 JSON 解析失败：" + e.getMessage()); }
    }

    /**
     * 导入技能包：先安全扫描，HIGH 一律阻断；
     * confirm=false 仅返回预检报告；confirm=true 且无 HIGH 时以 DRAFT 落库。
     */
    @Transactional
    public Map<String, Object> importPackage(String json, boolean confirm, String sourceTag) {
        return importPackage(json, confirm, sourceTag, false);
    }

    /** force=true：管理员已人工审核安全报告，接受 HIGH 风险强制安装（审计走 source 标记 + DRAFT 人工上架）。 */
    @Transactional
    public Map<String, Object> importPackage(String json, boolean confirm, String sourceTag, boolean force) {
        List<Skill> skills = parsePackage(json);
        List<Map<String, Object>> perSkill = new ArrayList<>();
        boolean hasHigh = false;
        boolean needsReview = false;   // 组合信号命中（体检 P2-3）：不阻断但须管理员显式接受
        for (Skill s : skills) {
            List<SkillSecurityService.Finding> fs = security.scan(s);
            Map<String, Object> rep = security.report(fs);
            if ("HIGH".equals(rep.get("risk"))) hasHigh = true;
            if (Boolean.TRUE.equals(rep.get("reviewRequired"))) needsReview = true;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", s.getName());
            m.put("description", s.getDescription());
            m.put("keywords", s.getTriggerKeywords());
            m.put("security", rep);
            perSkill.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("skills", perSkill);
        out.put("blocked", hasHigh && !force);
        out.put("reviewRequired", needsReview && !hasHigh && !force);
        if (!confirm) { out.put("preview", true); return out; }
        if (hasHigh && !force) {
            out.put("success", false);
            out.put("error", "存在 HIGH 级安全发现，已阻断安装。请人工审核安全报告后选择「接受风险安装」，或修复技能包重试。");
            return out;
        }
        // 人工复核档（体检 P2-3）：静态规则判不准的组合信号（外发能力×凭证词），
        // 黑名单正则漏判就直接放行的口子在此收住——必须管理员读过报告后显式接受。
        if (needsReview && !force) {
            out.put("success", false);
            out.put("error", "该技能同时具备外发能力与凭证/密钥相关内容，静态扫描无法判定是否安全，需**人工阅读技能内容**后确认。确认无外传行为请选择「接受风险安装」。");
            return out;
        }
        if (hasHigh || needsReview) out.put("forced", true);   // 管理员确认后的强制安装，落库仍为 DRAFT 待人工上架
        List<String> ids = new ArrayList<>();
        for (Skill s : skills) {
            s.setTargetSystemId(null);   // 外源环境系统 id 无意义，清空待重新绑定
            s.setSource(sourceTag == null ? "imported" : sourceTag);
            skillRepository.save(s);
            ids.add(s.getId());
        }
        out.put("success", true);
        out.put("installed", ids);
        return out;
    }

    /** GitHub 安装入口：目录地址 → 整目录 bundle 技能(SKILL.md+scripts);单文件 → 走包解析。force 语义同 importPackage。 */
    @Transactional
    public Map<String, Object> importGithub(String url, boolean confirm, boolean force) {
        GhLoc loc = resolveSkillDir(url);
        if (loc == null) return importPackage(downloadFromGithub(url), confirm, "github", force);   // 单文件(JSON/单md)

        Map<String, String> bundle = fetchGithubBundle(loc);
        // 仓库根目录时 dir 为空串，取最后一段会得到空名字 → 退回仓库名
        String fallbackName = loc.dir().isBlank() ? loc.repo() : loc.dir().substring(loc.dir().lastIndexOf('/') + 1);
        return installBundle(bundle, fallbackName, "github-dir", confirm, force);
    }

    /**
     * 从**技能目录**（SKILL.md + 脚本 + 参考资料）安装技能。GitHub 目录导入与本地 zip 导入共用这一条路径
     * ——安全扫描、类型派生、关键词派生、DRAFT 落库的规则必须**一模一样**，不能因为来源不同就松一档。
     */
    @Transactional
    public Map<String, Object> installBundle(Map<String, String> bundle, String fallbackName,
                                             String sourceTag, boolean confirm, boolean force) {
        String skillMd = bundle.entrySet().stream().filter(e -> e.getKey().equalsIgnoreCase("SKILL.md"))
                .map(Map.Entry::getValue).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("技能包内没有 SKILL.md（技能目录必须含 SKILL.md）"));
        Skill s = parseSkillMarkdown(skillMd);
        if (s.getName() == null || s.getName().isBlank()) s.setName(fallbackName);

        // iML 专有元数据（我们自己导出的包会带）：触发词、录制脚本、引擎类型、直达路由——
        // 这些 SKILL.md 的 frontmatter 装不下，丢了技能装进去也跑不起来（触发词没了 → 客户端永远匹配不到）。
        // 从 bundle 里取出后**移出 bundle**：它是元数据，不是技能文件，不该被当脚本扫描、也不该铺回目录。
        String metaJson = null;
        for (Map.Entry<String, String> e : new ArrayList<>(bundle.entrySet())) {
            if (e.getKey().equalsIgnoreCase("iml-skill.json")) { metaJson = e.getValue(); bundle.remove(e.getKey()); }
        }
        if (metaJson != null) applyImlMeta(s, metaJson);

        llm.ensureTriggerKeywords(s);   // 外源 SKILL.md 无 trigger_keywords → 自动派生，否则客户端永远匹配不到
        s.setId("skill-imp-" + UUID.randomUUID().toString().substring(0, 8));
        s.setStatus("DRAFT");
        s.setSource(sourceTag);
        s.setUpdatedAt(LocalDateTime.now());
        // 按目录内是否含可执行脚本定引擎类型（未显式声明 type 时）：纯指南目录 → knowledge，不进沙箱
        if (s.getType() == null || "knowledge".equals(s.getType())) s.setType(deriveTypeFromBundle(bundle));
        try { s.setBundle(mapper.writeValueAsString(bundle)); } catch (Exception e) { throw new IllegalArgumentException("bundle 序列化失败"); }

        // 安全扫描：SKILL.md(随 Skill) + 所有脚本文件
        List<SkillSecurityService.Finding> findings = new ArrayList<>(security.scan(s));
        findings.addAll(security.scanBundle(bundle));
        Map<String, Object> rep = security.report(findings);
        boolean high = "HIGH".equals(rep.get("risk"));

        Map<String, Object> skInfo = new LinkedHashMap<>();
        skInfo.put("name", s.getName());
        skInfo.put("description", s.getDescription());
        skInfo.put("keywords", s.getTriggerKeywords());
        skInfo.put("bundleFiles", new ArrayList<>(bundle.keySet()));
        skInfo.put("security", rep);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("skills", List.of(skInfo));
        boolean needsReview = Boolean.TRUE.equals(rep.get("reviewRequired"));
        out.put("blocked", high && !force);
        out.put("reviewRequired", needsReview && !high && !force);
        if (!confirm) { out.put("preview", true); return out; }
        if (high && !force) {
            out.put("success", false);
            out.put("error", "存在 HIGH 级安全发现，已阻断安装。请人工审核安全报告后选择「接受风险安装」，或修复技能包重试。");
            return out;
        }
        if (needsReview && !force) {
            out.put("success", false);
            out.put("error", "该技能同时具备外发能力与凭证/密钥相关内容，静态扫描无法判定是否安全，需**人工阅读技能内容**后确认。确认无外传行为请选择「接受风险安装」。");
            return out;
        }
        if (high || needsReview) out.put("forced", true);   // 管理员确认后的强制安装，落库仍为 DRAFT 待人工上架
        s.setTargetSystemId(null);
        skillRepository.save(s);
        out.put("success", true);
        out.put("installed", List.of(s.getId()));
        return out;
    }

    /** 把 iml-skill.json 里的元数据合并到技能上（只补 SKILL.md 装不下的字段，不覆盖已从 md 解析出的名称/描述）。 */
    private void applyImlMeta(Skill s, String metaJson) {
        try {
            com.fasterxml.jackson.databind.JsonNode n = mapper.readTree(metaJson);
            if (blank(s.getName())) s.setName(n.path("name").asText(""));
            if (blank(s.getDescription())) s.setDescription(n.path("description").asText(""));
            if (!n.path("type").asText("").isBlank()) s.setType(n.path("type").asText());
            if (!n.path("category").asText("").isBlank()) s.setCategory(n.path("category").asText());
            if (!n.path("version").asText("").isBlank()) s.setVersion(n.path("version").asText());
            if (blank(s.getSopContent())) s.setSopContent(n.path("sopContent").asText(""));
            if (!n.path("code").asText("").isBlank()) s.setCode(n.path("code").asText());
            if (!n.path("actionScript").asText("").isBlank()) s.setActionScript(n.path("actionScript").asText());
            if (!n.path("skillKind").asText("").isBlank()) s.setSkillKind(n.path("skillKind").asText());
            if (!n.path("navHash").asText("").isBlank()) s.setNavHash(n.path("navHash").asText());
            if (n.path("triggerKeywords").isArray() && (s.getTriggerKeywords() == null || s.getTriggerKeywords().isEmpty())) {
                List<String> kws = new ArrayList<>();
                n.path("triggerKeywords").forEach(k -> kws.add(k.asText()));
                s.setTriggerKeywords(kws);
            }
            if (n.path("allowedRoles").isArray()) {
                List<String> roles = new ArrayList<>();
                n.path("allowedRoles").forEach(r -> roles.add(r.asText()));
                if (!roles.isEmpty()) s.setAllowedRoles(roles);
            }
        } catch (Exception ignored) { /* 元数据坏了不阻断安装：SKILL.md 仍是技能的主体 */ }
    }

    private static boolean blank(String x) { return x == null || x.isBlank(); }

    /**
     * 解压技能包 zip → 文件目录（复用 GitHub 目录导入的同一套白名单与上限）。
     * 只收文本类文件；目录前缀（GitHub 下载的 zip 常带一层 repo-name/）自动剥掉。
     * 防 zip-slip：条目名含 .. 或绝对路径一律拒收。
     */
    public Map<String, String> unzipBundle(byte[] data) {
        Map<String, String> files = new LinkedHashMap<>();
        long total = 0;
        try (java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(data))) {
            java.util.zip.ZipEntry e;
            while ((e = zis.getNextEntry()) != null) {
                if (e.isDirectory()) continue;
                String name = e.getName().replace('\\', '/');
                if (name.contains("..") || name.startsWith("/")) throw new IllegalArgumentException("技能包内含非法路径：" + name);
                if (name.contains("__MACOSX/") || name.substring(name.lastIndexOf('/') + 1).startsWith("._")) continue;
                String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
                if (!TEXT_EXT.contains(ext)) continue;                      // 二进制/图片跳过：撑库且无扫描意义
                if (files.size() >= MAX_BUNDLE_FILES) throw new IllegalArgumentException("技能包文件数超过上限 " + MAX_BUNDLE_FILES);
                byte[] buf = zis.readAllBytes();
                total += buf.length;
                if (total > MAX_BUNDLE_BYTES) throw new IllegalArgumentException("技能包总大小超过上限 " + (MAX_BUNDLE_BYTES / 1_000_000) + "MB");
                files.put(name, new String(buf, java.nio.charset.StandardCharsets.UTF_8));
            }
        } catch (IllegalArgumentException ex) { throw ex;
        } catch (Exception ex) { throw new IllegalArgumentException("技能包解压失败：" + ex.getMessage()); }
        if (files.isEmpty()) throw new IllegalArgumentException("技能包里没有可识别的文本文件");
        return stripCommonPrefix(files);
    }

    /** 剥掉 zip 里统一的顶层目录（如 my-skill/SKILL.md → SKILL.md），否则找不到 SKILL.md。 */
    private static Map<String, String> stripCommonPrefix(Map<String, String> files) {
        String prefix = null;
        for (String k : files.keySet()) {
            int i = k.indexOf('/');
            if (i < 0) return files;                       // 有文件在根，说明没有统一前缀
            String p = k.substring(0, i + 1);
            if (prefix == null) prefix = p;
            else if (!prefix.equals(p)) return files;      // 前缀不一致 → 不剥
        }
        if (prefix == null) return files;
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : files.entrySet()) out.put(e.getKey().substring(prefix.length()), e.getValue());
        return out;
    }
}
