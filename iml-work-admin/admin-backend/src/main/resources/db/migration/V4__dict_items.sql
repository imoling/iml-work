-- 数据字典：系统内各类"分类/枚举"的单一事实来源（企业知识分类、本体业务域、业务系统类型…）。
-- 治硬编码：同一套分类曾散落三端六处代码，改分类需发版；入库后管理端「字典管理」页运行时可维护。
CREATE TABLE IF NOT EXISTS dict_item (
    id         BIGSERIAL PRIMARY KEY,
    type       VARCHAR(64)  NOT NULL,
    label      VARCHAR(128) NOT NULL,
    sort_order INT          NOT NULL DEFAULT 0,
    enabled    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP    NOT NULL DEFAULT now(),
    CONSTRAINT uq_dict_type_label UNIQUE (type, label)
);

CREATE INDEX IF NOT EXISTS idx_dict_item_type ON dict_item (type, enabled, sort_order);

-- 种子：与既有硬编码取值一致（存量数据里的 category 字符串不受影响）
INSERT INTO dict_item (type, label, sort_order) VALUES
    ('knowledge_category', '公司基本信息', 1),
    ('knowledge_category', '行政财务制度', 2),
    ('knowledge_category', '企业合规制度', 3),
    ('knowledge_category', '人事审批规范', 4),
    ('ontology_domain', 'OA', 1),
    ('ontology_domain', 'CRM', 2),
    ('ontology_domain', 'ERM', 3),
    ('biz_system_type', 'OA', 1),
    ('biz_system_type', 'CRM', 2),
    ('biz_system_type', 'EMAIL', 3),
    ('biz_system_type', 'GITHUB', 4),
    ('biz_system_type', 'ERP', 5),
    ('biz_system_type', 'OTHER', 6)
ON CONFLICT (type, label) DO NOTHING;
