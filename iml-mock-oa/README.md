# 华信数字 · 企业协同平台（Mock OA/CRM）

一个**看起来像传统企业系统**的 mock OA/CRM（侧边栏菜单、流程编号、申请人、审批意见、跟进方式等传统字段），用于演示本体层盖在真实业务系统之上。单个 Node/Express 服务，数据在内存，重启即复位。**仅演示，勿用于生产。**

## 启动

```bash
cd iml-mock-oa
npm install
npm start          # 监听 http://localhost:8090（可用 MOCK_OA_PORT 改端口）
```

登录：任意账号/密码（演示登录态只在本地浏览器 Profile）。

## 页面与选择器（供 FDE 录制连接器动作）

| 页面 | 路径 | 可映射的本体动作 | 关键选择器 |
| --- | --- | --- | --- |
| 登录 | `/login` | —（登录态本地） | `#username` `#password` `#loginBtn` |
| 门户首页 | `/portal` | — | — |
| 合同审批列表 | `/contract/list` | — | 行链接进详情 |
| 合同审批详情 | `/contract/:id`（如 `/contract/HT-2026-0028`） | `ApprovalTask.approve` / `reject` | `#opinion`（审批意见）`#approveBtn`（同意）`#rejectBtn`（退回） |
| 商机列表 | `/crm/opportunities` | — | 行链接进详情 |
| 商机详情 | `/crm/opportunity/:id`（如 `/crm/opportunity/SJ20260012`） | `Opportunity.advanceStage` | `#stage`（销售阶段下拉）`#advanceBtn`（保存） |
| 新建跟进 | `/crm/follow/new` | `VisitEvent.logVisit` | `#customer` `#contact` `#way`（跟进方式）`#visitDate` `#summary` `#submitBtn` |
| 跟进记录台账 | `/crm/follow` | — | — |
| 状态快照(JSON) | `/api/state` | —（验证写入是否落库） | — |

内置演示数据：客户「宝钢集团」、联系人「李建国（采购部主任）」、两条待审批合同（280万 `HT-2026-0028` / 6000万加急 `HT-2026-0031`）、两个商机（`SJ20260012` 初步接触 / `SJ20260018` 方案报价）。销售阶段：初步接触→需求确认→方案报价→商务谈判→赢单/输单。

## 与本体的接线（已在管理端配置）

- 管理端已建业务系统 **「Mock OA/CRM (演示)」→ http://localhost:8090**，7 个本体对象类型的 `boundSystemId` 已指向它。
- 在 FDE 工作台针对上述页面**录制连接器动作**（如「同意」录制点击 `#approveBtn`；「新建跟进」录制填表 + 点 `#submitBtn`），产出 `ConnectorAction`。
- 管理端「本体建模 · 对象动作」把连接器动作**绑定**到对应本体动作。
- 客户端「设置 → 企业系统连接」登录该 Mock 系统后，发自然语言指令即可真实回放执行，并回写业务事件。
