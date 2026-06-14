import { useState } from 'react'
import {
  ShieldCheck, Link2, Boxes, FilePlus2, ReceiptText, Plane, Stamp, Search, FileBarChart,
  Paperclip, Layers, FolderOpen, KeyRound, ArrowUp
} from 'lucide-react'
import { useUserStore } from '../stores/userStore'

interface WorkbenchProps {
  onStartTask: (text: string) => void
  onNavigate: (tab: string) => void
}

const FLOWS = [
  { icon: <FilePlus2 size={18} />, title: '新建审批', desc: '发起各类审批流程', prompt: '帮我新建一个审批流程' },
  { icon: <ReceiptText size={18} />, title: '报销单检查', desc: '检查报销合规性', prompt: '检查这张报销单是否合规' },
  { icon: <Plane size={18} />, title: '出差申请', desc: '发起出差申请流程', prompt: '帮我发起一个出差申请' },
  { icon: <Stamp size={18} />, title: '合同用印预审', desc: '合同用印前合规检查', prompt: '帮我做合同用印预审' },
  { icon: <Search size={18} />, title: '查询审批状态', desc: '查询审批进度与结果', prompt: '查询我的审批状态' },
  { icon: <FileBarChart size={18} />, title: '生成日报', desc: '生成今日工作日报', prompt: '帮我生成今天的工作日报' },
]

export default function Workbench({ onStartTask, onNavigate }: WorkbenchProps) {
  const { userNickname } = useUserStore()
  const [text, setText] = useState('')

  const submit = () => {
    const t = text.trim()
    if (!t) return
    onStartTask(t)
    setText('')
  }

  return (
    <div className="wb">
      <div className="wb-inner">
        <div className="wb-hero-title">{userNickname}，今天让工作分身处理什么？</div>
        <div className="wb-hero-sub">本地安全环境已启用，已连接企业系统与常用业务技能。</div>

        <div className="wb-status-row">
          <div className="wb-stat">
            <div className="wb-stat-ic"><ShieldCheck size={18} /></div>
            <div><div className="wb-stat-t">本地沙箱已启用</div><div className="wb-stat-s">数据不出本地</div></div>
          </div>
          <div className="wb-stat">
            <div className="wb-stat-ic"><Link2 size={18} /></div>
            <div><div className="wb-stat-t">OA 已连接</div><div className="wb-stat-s">会话保持中</div></div>
          </div>
          <div className="wb-stat">
            <div className="wb-stat-ic"><Boxes size={18} /></div>
            <div><div className="wb-stat-t">3 个业务技能可用</div><div className="wb-stat-s">随时调用</div></div>
          </div>
        </div>

        <div className="wb-section-title">常用流程</div>
        <div className="wb-flow-grid">
          {FLOWS.map((f) => (
            <div key={f.title} className="wb-flow-card" onClick={() => onStartTask(f.prompt)}>
              <div className="wb-flow-ic">{f.icon}</div>
              <div className="wb-flow-t">{f.title}</div>
              <div className="wb-flow-d">{f.desc}</div>
            </div>
          ))}
        </div>

        <div className="wb-cmd">
          <textarea
            className="wb-cmd-input"
            rows={2}
            placeholder="输入任务，让工作分身开始处理…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          />
          <div className="wb-cmd-tools">
            <button className="wb-tool"><Paperclip size={13} />附件</button>
            <button className="wb-tool" onClick={() => onNavigate('skills')}><Layers size={13} />业务技能</button>
            <button className="wb-tool" onClick={() => onNavigate('files')}><FolderOpen size={13} />工作空间</button>
            <button className="wb-tool"><KeyRound size={13} />权限范围</button>
            <button className="wb-send" onClick={submit} title="发送"><ArrowUp size={16} /></button>
          </div>
        </div>
      </div>
    </div>
  )
}
