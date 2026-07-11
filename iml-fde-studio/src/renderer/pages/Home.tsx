import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Admin, Connections, Ontology, SkillCenter, Browser } from '../services/api'
import { PageHeader, useAsync, Loading, ErrorBox } from '../components/ui'
import Icon from '../components/Icon'

/*
 * 工作台首页 = 使用指南 + 真实进度。
 * FDE 的四步交付流（也是左侧菜单顺序）：
 *   ① 系统连接：登录客户业务系统，验证会话，授权可调用操作
 *   ② 本体建模：把系统里的业务对象/动作建成本体（分身理解业务的地基）
 *   ③ 技能构建：录制业务操作 → 炼成技能 → 上架到企业技能中心
 *   ④ 技能测试：用一句话真跑技能，通过后交付给岗位分身
 * 卡片上的计数全部来自真实接口，不再展示无数据支撑的「项目/场景/漏斗」。
 */
export default function Home() {
  const nav = useNavigate()
  const { data, loading, error, reload } = useAsync(async () => {
    const [systems, conns, types, actions, skills] = await Promise.all([
      Admin.integrations().catch(() => []),
      Connections.list().catch(() => []),
      Ontology.types().catch(() => []),
      Ontology.actions().catch(() => []),
      SkillCenter.list().catch(() => [])
    ])
    return {
      systems: systems || [], conns: conns || [],
      types: types || [], actions: actions || [], skills: skills || []
    }
  }, [])

  return (
    <>
      <PageHeader title="FDE 工作台" desc="四步把客户业务变成岗位分身能执行的技能：连接系统 → 建模本体 → 构建技能 → 真跑测试" />
      <div className="content grid" style={{ gap: 16 }}>
        {loading ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : <Flow {...data} nav={nav} />}
      </div>
    </>
  )
}

function Flow({ systems, conns, types, actions, skills, nav }) {
  const verified = conns.filter(c => c.status === 'verified').length
  const enabled = skills.filter(s => s.status !== 'DISABLED').length
  const browserOk = Browser.available()

  const steps = [
    {
      ic: 'link', path: '/connections', title: '① 系统连接',
      desc: '登录客户的 OA / CRM / ERP 等业务系统并验证会话。登录态只存本机，平台不存密码。后面两步的录制与真跑都复用这里的登录。',
      stat: `${systems.length} 个系统 · ${verified} 个已验证`,
      done: verified > 0,
      todo: verified === 0 ? '还没有已验证的系统连接——先从这里开始' : ''
    },
    {
      ic: 'grid', path: '/ontology', title: '② 本体建模',
      desc: '把业务对象（合同、工单、商机…）与动作（审批、开工、收货…）建成本体，并把录制/API 挂成连接器动作。分身靠它理解「操作的是什么业务」。',
      stat: `${types.length} 个对象类型 · ${actions.length} 个动作`,
      done: types.length > 0,
      todo: types.length === 0 ? '还没有本体对象——建模后分身才能按业务语义执行' : ''
    },
    {
      ic: 'spark', path: '/quick', title: '③ 技能构建',
      desc: '在真实系统里录制一遍业务操作，AI 提炼成带触发词与确认表单的技能，上架到企业技能中心供各岗位装配。',
      stat: `${skills.length} 个技能 · ${enabled} 个已上架`,
      done: skills.length > 0,
      todo: skills.length === 0 ? '还没有技能——录一遍操作即可炼成' : ''
    },
    {
      ic: 'check', path: '/test', title: '④ 技能测试',
      desc: '像员工一样发一句话，真实链路跑一遍技能（提炼字段 → 确认 → 执行），通过后即可交付给岗位分身使用。',
      stat: browserOk ? '浏览器执行器就绪' : '仅桌面端可真跑',
      done: browserOk,
      todo: ''
    }
  ]

  return (
    <>
      {steps.map(s => (
        <div key={s.path} className="card clickable" style={{ display: 'flex', gap: 16, alignItems: 'flex-start', cursor: 'pointer' }} onClick={() => nav(s.path)}>
          <div className="stat-ic" style={{ flexShrink: 0, marginTop: 2 }}><Icon name={s.ic} size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{s.title}</span>
              <span className="sec" style={{ fontSize: 12 }}>{s.stat}</span>
              {s.done
                ? <span style={{ fontSize: 11, color: '#16a34a', border: '1px solid rgba(22,163,74,.3)', borderRadius: 999, padding: '1px 8px' }}>已就绪</span>
                : <span style={{ fontSize: 11, color: '#b45309', border: '1px solid rgba(180,83,9,.3)', borderRadius: 999, padding: '1px 8px' }}>待完成</span>}
            </div>
            <div className="sec" style={{ marginTop: 6, lineHeight: 1.6 }}>{s.desc}</div>
            {s.todo && <div style={{ marginTop: 6, fontSize: 12, color: '#b45309' }}>▸ {s.todo}</div>}
          </div>
          <button className="primary" style={{ flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); nav(s.path) }}>进入</button>
        </div>
      ))}

      <div className="card" style={{ background: 'rgba(55,201,139,0.05)', border: '1px solid rgba(55,201,139,0.25)' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>安全约定</div>
        <div className="sec" style={{ lineHeight: 1.8 }}>
          · 凭证与登录态只保存在本机受管环境，平台只登记系统地址与验证状态<br />
          · 本体只存 Schema 与对象引用，实例数据现查现用、不上传<br />
          · 写操作（提交/审批/删除）执行前必须人工确认，高危动作需一次性签名令牌
        </div>
      </div>
    </>
  )
}
