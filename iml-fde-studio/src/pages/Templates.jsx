import React from 'react'
import { Templates } from '../services/api.js'
import { PageHeader, useAsync, Loading, ErrorBox, Tag } from '../components/ui.jsx'

const TYPE_LABEL = { industry: '行业', role: '岗位', process: '流程', skill: 'SKILL', executor: '执行器', acceptance_case: '验收用例' }

export default function TemplatesPage() {
  const { data, loading, error, reload } = useAsync(() => Templates.list(), [])
  return (
    <>
      <PageHeader title="模板库" desc="沉淀可复用的行业 / 岗位 / 流程 / SKILL 模板" />
      <div className="content">
        {loading ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : (
          (data || []).length === 0 ? <div className="card"><div className="empty">还没有模板。试运行通过并交付的场景可沉淀为模板复用。</div></div> : (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))' }}>
              {data.map(t => (
                <div key={t.id} className="card">
                  <Tag kind="blue">{TYPE_LABEL[t.type] || t.type}</Tag>
                  <div style={{ fontWeight: 700, margin: '8px 0 4px' }}>{t.name}</div>
                  <div className="sec" style={{ fontSize: 12 }}>v{t.version}</div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </>
  )
}
