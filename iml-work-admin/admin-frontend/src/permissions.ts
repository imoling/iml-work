// 权限点常量（与后端 com.imlwork.admin.security.Permissions 对应）
export const Permissions = {
  DASHBOARD_VIEW: 'admin.dashboard.view',
  EXPERT_MANAGE: 'admin.expert.manage',
  SKILL_MANAGE: 'admin.skill.manage',
  KNOWLEDGE_MANAGE: 'admin.knowledge.manage',
  KNOWLEDGE_APPROVE: 'admin.knowledge.approve',
  GATEWAY_MANAGE: 'admin.gateway.manage',
  SEARCH_MANAGE: 'admin.search.manage',
  TRACE_VIEW: 'admin.trace.view',
  SANDBOX_MANAGE: 'admin.sandbox.manage',
  DOCLING_MANAGE: 'admin.docling.manage',
  INTEGRATION_MANAGE: 'admin.integration.manage',
  ENTERPRISE_MANAGE: 'admin.enterprise.manage',
  USER_MANAGE: 'admin.user.manage',
  ONTOLOGY_MANAGE: 'admin.ontology.manage',
  FDE_ACCESS: 'fde.access',
  FDE_SKILL_AUTHOR: 'fde.skill.author',
  CLIENT_USE: 'client.use'
} as const
