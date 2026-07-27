import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { swallow } from '../../utils'

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, CanvasRenderer])

// ```chart 围栏协议：模型只产结构化 JSON，图表由本地 ECharts 确定性渲染（离线可用、样式统一、
// 不让模型手写 HTML/配色——自由生成整页 HTML 的可靠性翻车已有同行实锤）。
// 形状：{"type":"bar|line|area|pie","title":"...","x":["类目",...],"series":[{"name":"...","data":[数,...]}],"unit":"单位"}
// pie 用 "data":[{"name":"...","value":数},...]。规范（dataviz）：一图一坐标系不做双轴；系列上限 8。
export interface ChartSpec {
  type?: string
  title?: string
  unit?: string
  x?: unknown[]
  series?: { name?: string; data?: unknown[] }[]
  data?: { name?: string; value?: number }[]
}

// dataviz 参考调色板（过 CVD/对比度验证的**定序**，两列同色异阶按主题选列；顺序即安全机制，禁止循环生成色相）
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const MAX_SERIES = 8

const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null }

// 解析 + 可渲染性校验：返回 null 表示「按普通代码块回退展示」（流式半截 JSON / 模型写坏时绝不吞内容）
export function parseChartSpec(raw: string): ChartSpec | null {
  let spec: ChartSpec
  try { spec = JSON.parse(raw) } catch { return null }
  if (!spec || typeof spec !== 'object') return null
  const type = String(spec.type || 'bar').toLowerCase()
  if (type === 'pie') {
    const slices = Array.isArray(spec.data) ? spec.data : (Array.isArray(spec.series?.[0]?.data) ? (spec.series![0].data as { name?: string; value?: number }[]) : [])
    return slices.some(s => s && typeof s === 'object' && num(s.value) !== null) ? spec : null
  }
  if (!['bar', 'line', 'area'].includes(type)) return null
  const hasData = Array.isArray(spec.series) && spec.series.some(s => Array.isArray(s?.data) && s.data.some(v => num(v) !== null))
  return hasData ? spec : null
}

const cssVar = (name: string, fallback: string) =>
  (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim() || fallback

function buildOption(spec: ChartSpec): Record<string, unknown> {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  const palette = dark ? SERIES_DARK : SERIES_LIGHT
  const ink = cssVar('--text-primary', dark ? '#E5EAF3' : '#1F2937')
  const inkMuted = cssVar('--text-muted', dark ? '#8B93A7' : '#6B7280')
  const surface = cssVar('--bg-card', dark ? '#111A2B' : '#FFFFFF')
  const hairline = dark ? 'rgba(255,255,255,0.08)' : 'rgba(17,24,39,0.08)'
  const type = String(spec.type || 'bar').toLowerCase()
  const title = spec.title ? {
    text: String(spec.title), left: 4, top: 2,
    textStyle: { color: ink, fontSize: 13, fontWeight: 600 as const },
  } : undefined
  const tooltip = {
    backgroundColor: surface, borderColor: hairline, textStyle: { color: ink, fontSize: 12 },
    trigger: type === 'pie' ? 'item' as const : 'axis' as const,
  }

  if (type === 'pie') {
    const slices = (Array.isArray(spec.data) ? spec.data : (spec.series?.[0]?.data as { name?: string; value?: number }[] | undefined) || [])
      .filter(s => s && typeof s === 'object' && num(s.value) !== null)
      .slice(0, MAX_SERIES)
      .map(s => ({ name: String(s.name ?? ''), value: num(s.value)! }))
    return {
      color: palette, title, tooltip,
      legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: inkMuted, fontSize: 11 } },
      series: [{
        type: 'pie', radius: ['42%', '70%'], center: ['50%', '52%'], data: slices,
        itemStyle: { borderColor: surface, borderWidth: 2 },   // 2px 表面缝隙分隔相邻扇区
        label: { color: inkMuted, fontSize: 11 },
        labelLine: { lineStyle: { color: hairline } },
      }],
    }
  }

  const seriesIn = (spec.series || []).slice(0, MAX_SERIES)
  const showLegend = seriesIn.length >= 2   // 单系列不放图例：标题即系列名
  return {
    color: palette, title, tooltip,
    ...(showLegend ? { legend: { bottom: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: inkMuted, fontSize: 11 } } } : {}),
    grid: { left: 8, right: 14, top: title ? 36 : 18, bottom: showLegend ? 32 : 8, containLabel: true },
    xAxis: {
      type: 'category', data: (spec.x || []).map(v => String(v)),
      axisLine: { lineStyle: { color: hairline } }, axisTick: { show: false },
      axisLabel: { color: inkMuted, fontSize: 11 },
    },
    yAxis: {
      type: 'value', name: spec.unit ? String(spec.unit) : undefined,
      nameTextStyle: { color: inkMuted, fontSize: 11 },
      splitLine: { lineStyle: { color: hairline } },
      axisLabel: { color: inkMuted, fontSize: 11 },
    },
    series: seriesIn.map(s => {
      const data = (s.data || []).map(num)
      const name = s.name ? String(s.name) : undefined
      if (type === 'bar') return { name, data, type: 'bar', barMaxWidth: 26, itemStyle: { borderRadius: [4, 4, 0, 0] } }
      return {
        name, data, type: 'line', symbol: 'circle', symbolSize: 8, lineStyle: { width: 2 },
        ...(type === 'area' ? { areaStyle: { opacity: 0.15 } } : {}),
      }
    }),
  }
}

export function ChartBlock({ raw }: { raw: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const spec = useMemo(() => parseChartSpec(raw), [raw])
  useEffect(() => {
    if (!ref.current || !spec) return
    const chart = echarts.init(ref.current)
    const apply = () => { try { chart.setOption(buildOption(spec), true) } catch (e) { swallow(e, 'chart-block') } }
    apply()
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(ref.current)
    // 主题切换（<html data-theme>）时按新主题重建配色与文字色
    const mo = new MutationObserver(apply)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { ro.disconnect(); mo.disconnect(); chart.dispose() }
  }, [spec])
  if (!spec) return null
  return (
    <div className="md-chartblock">
      <div ref={ref} style={{ width: '100%', height: String(spec.type).toLowerCase() === 'pie' ? 260 : 280 }} />
    </div>
  )
}
