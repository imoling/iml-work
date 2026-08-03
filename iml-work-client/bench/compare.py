# 两次评测结果对比：准确率 / 时延 / 超时数逐集并排，看清一次改动到底动了什么。
# 用法：python3 bench/compare.py <基线graded.jsonl> <新graded.jsonl> [基线名] [新名]
import json, sys
from pathlib import Path
from collections import Counter

SP = Path(__file__).resolve().parent
ORDER = ['simpleqa', 'csimpleqa', 'frames', 'gaia', 'gsm8k', 'ifeval']


def load(name):
    p = SP / 'results' / name
    rows = [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
    by = {}
    for r in rows:
        by.setdefault(r['benchmark'], []).append(r)
    return by


def stat(rs):
    """一个集的汇总：准确率、超时数、p50。超时单列——它既是时延问题也是准确率损失。"""
    if not rs:
        return None
    c = Counter(r.get('grade') for r in rs)
    ms = sorted(r.get('ms', 0) for r in rs)
    return {
        'n': len(rs),
        'acc': 100 * c['CORRECT'] / len(rs),
        'to': sum(1 for r in rs if r.get('timedOut')),
        'na': c['NOT_ATTEMPTED'],
        'p50': ms[len(ms) // 2] / 1000,
    }


def main(base_file, new_file, base_name='基线', new_name='本轮'):
    a, b = load(base_file), load(new_file)
    print(f"{'集':<11}{base_name+' acc':>11}{new_name+' acc':>11}{'Δacc':>8}"
          f"{'超时':>10}{'未答':>10}{'p50 s':>13}")
    print('-' * 76)
    tot_a = tot_b = n_a = n_b = 0
    for k in ORDER:
        sa, sb = stat(a.get(k, [])), stat(b.get(k, []))
        if not sa and not sb:
            continue
        if sa:
            tot_a += sa['acc'] * sa['n']; n_a += sa['n']
        if sb:
            tot_b += sb['acc'] * sb['n']; n_b += sb['n']
        d = (sb['acc'] - sa['acc']) if (sa and sb) else 0
        arrow = '↑' if d > 0.5 else ('↓' if d < -0.5 else '·')
        acc_a = f"{sa['acc']:.1f}%" if sa else '-'
        acc_b = f"{sb['acc']:.1f}%" if sb else '-'
        to = f"{sa['to'] if sa else '-'}→{sb['to'] if sb else '-'}"
        na = f"{sa['na'] if sa else '-'}→{sb['na'] if sb else '-'}"
        p50 = f"{sa['p50']:.0f}→{sb['p50']:.0f}" if (sa and sb) else '-'
        print(f"{k:<11}{acc_a:>11}{acc_b:>11}{d:>+7.1f}{arrow}{to:>10}{na:>10}{p50:>13}")
    print('-' * 76)
    if n_a and n_b:
        ma, mb = tot_a / n_a, tot_b / n_b
        print(f"{'加权平均':<11}{ma:>10.1f}%{mb:>10.1f}%{mb-ma:>+7.1f}")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__ or '用法：python3 bench/compare.py <基线> <新> [基线名] [新名]')
        sys.exit(2)
    main(*sys.argv[1:5])
