#!/usr/bin/env python3
"""两轮基准测试对比：老题集 / 新题集 / 历史基线。

为什么主看「两轮互比」而不是「与基线比」：两轮在同一晚、同一网络条件下跑完，
而基线是另一天的——今晚英文检索经代理出海慢了 6 倍（不联网的 GSM8K/IFEval 中位耗时
两天完全一致，是干净的对照），跨天比会把网络时延读成能力变化。

两轮题目零重合（GAIA 20 题除外，那是**有意保留的对照锚点**）：
老题集涨而新题集不涨 = 过拟合到题目上了；两轮一致 = 能力是真的。
"""
import json, collections, sys, pathlib

SP = pathlib.Path(__file__).resolve().parent
NAMES = {'sq': 'SimpleQA', 'cq': 'C-SimpleQA', 'fr': 'FRAMES', 'ga': 'GAIA', 'gs': 'GSM8K', 'if': 'IFEval'}
ORDER = ['sq', 'cq', 'fr', 'ga', 'gs', 'if']


def load(name):
    p = SP / 'results' / name
    if not p.exists():
        return None
    rows = [json.loads(l) for l in open(p) if l.strip()]
    tot = collections.Counter(r['id'][:2] for r in rows)
    ok = collections.Counter(r['id'][:2] for r in rows if r.get('grade') == 'CORRECT')
    # 基础设施失败：模型/网络层面挂掉或撞硬闸，不是答错。单列出来，不从主口径里偷偷剔掉。
    infra = [r for r in rows if r.get('error')]
    med = {}
    for k in ORDER:
        ms = sorted(r['ms'] for r in rows if r['id'][:2] == k)
        med[k] = ms[len(ms) // 2] / 1000 if ms else 0
    return {'rows': rows, 'tot': tot, 'ok': ok, 'infra': infra, 'med': med,
            'acc': sum(ok.values()) / max(1, sum(tot.values())) * 100}


def table(cols):
    """cols: [(标题, data)]，data 为 load() 结果。"""
    head = f"{'套件':<12}" + ''.join(f"{t:>16}" for t, _ in cols)
    print(head)
    print('-' * len(head))
    for k in ORDER:
        line = f"{NAMES[k]:<12}"
        for _, d in cols:
            if not d or not d['tot'][k]:
                line += f"{'—':>16}"
            else:
                line += f"{d['ok'][k]:>3}/{d['tot'][k]:<2}{d['ok'][k]/d['tot'][k]*100:>6.1f}%"
        print(line)
    print('-' * len(head))
    line = f"{'总计':<12}"
    for _, d in cols:
        line += f"{sum(d['ok'].values()):>3}/{sum(d['tot'].values()):<2}{d['acc']:>6.1f}%" if d else f"{'—':>16}"
    print(line)


def main():
    r1 = load(sys.argv[1] if len(sys.argv) > 1 else 'graded-r1-old.jsonl')
    r2 = load(sys.argv[2] if len(sys.argv) > 2 else 'graded-r2-new.jsonl')
    base = load('graded_turn_full.jsonl')
    cols = [('基线(8/1)', base), ('R1 老题集', r1), ('R2 新题集', r2)]
    print('=' * 60)
    print('准确率')
    print('=' * 60)
    table([c for c in cols if c[1]])

    print()
    print('=' * 60)
    print('单题中位耗时（秒）—— 不联网套件是网络条件的对照组')
    print('=' * 60)
    head = f"{'套件':<12}" + ''.join(f"{t:>14}" for t, d in cols if d)
    print(head)
    for k in ORDER:
        print(f"{NAMES[k]:<12}" + ''.join(f"{d['med'][k]:>13.0f}s" for _, d in cols if d))

    print()
    print('=' * 60)
    print('基础设施失败（模型/网络层挂掉或撞硬闸，非答错）')
    print('=' * 60)
    for t, d in cols:
        if not d:
            continue
        print(f'{t}: {len(d["infra"])} 题' + (' — ' + '、'.join(r['id'] for r in d['infra']) if d['infra'] else ''))

    if r1 and r2:
        print()
        print('=' * 60)
        print('过拟合判据：两轮同夜同条件，题目零重合（GAIA 除外，为对照锚点）')
        print('=' * 60)
        d = r2['acc'] - r1['acc']
        print(f'  R1 {r1["acc"]:.1f}%  →  R2 {r2["acc"]:.1f}%   差 {d:+.1f} 个百分点')
        print(f'  GAIA（两轮同题）: R1 {r1["ok"]["ga"]}/{r1["tot"]["ga"]}  R2 {r2["ok"]["ga"]}/{r2["tot"]["ga"]}  ← 同题不同轮，衡量运行间抖动')


if __name__ == '__main__':
    main()
