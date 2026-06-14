import { Workflow, Clock, Plus, Repeat } from 'lucide-react'

const SAMPLES = [
  { title: '每日工作日报', desc: '每个工作日 18:00 自动生成并归档日报', cadence: '每日 18:00', on: true },
  { title: '报销单合规巡检', desc: '每周一上午扫描待处理报销单并标记风险', cadence: '每周一 09:00', on: false },
]

export default function AutomationView() {
  return (
    <div className="wb">
      <div className="wb-inner">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="wb-hero-title" style={{ fontSize: 22 }}>自动化</div>
            <div className="wb-hero-sub">设定定时任务，让工作分身在指定时间自动执行流程。</div>
          </div>
          <button className="settings-btn"><Plus size={15} />新建自动化</button>
        </div>

        <div className="wb-section-title">定时任务</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {SAMPLES.map(s => (
            <div key={s.title} className="svc-card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div className="svc-ic"><Repeat size={18} /></div>
              <div style={{ flex: 1 }}>
                <div className="svc-name">{s.title}</div>
                <div className="svc-meta" style={{ marginTop: 4 }}>{s.desc}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
                <Clock size={13} />{s.cadence}
              </div>
              <span className={`pill ${s.on ? 'pill-mint' : 'pill-gray'}`}>
                <span className="pill-dot" />{s.on ? '已启用' : '已暂停'}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20, fontSize: 12, color: 'var(--text-muted)' }}>
          <Workflow size={14} /> 自动化任务在本地安全环境中按计划唤起工作分身执行。
        </div>
      </div>
    </div>
  )
}
