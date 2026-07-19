# 判分任意 results 目录（复用 grade.py 的判分逻辑），用法：python3 grade_dir.py round2
import json, sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import grade as G

SP = Path(__file__).resolve().parent
sub = sys.argv[1] if len(sys.argv) > 1 else 'round2'
resdir = SP / sub
tasks = {}
for l in open(SP / 'data' / 'tasks.jsonl'):
    t = json.loads(l); tasks[t['benchmark'] + '/' + t['id']] = t
recs = []
for l in open(resdir / 'results.jsonl'):
    r = json.loads(l)
    t = tasks.get(r['benchmark'] + '/' + r['id'])
    if t and 'meta' in t: r['meta'] = t['meta']
    recs.append(r)

def grade_one(r):
    b = r['benchmark']
    try:
        if b in ('simpleqa', 'csimpleqa'): r['grade'] = G.grade_llm(r, G.SIMPLEQA_GRADER)
        elif b in ('frames', 'gaia'): r['grade'] = G.grade_llm(r, G.EQUIV_GRADER)
        elif b == 'gsm8k': r['grade'] = G.grade_gsm8k(r)
        elif b == 'ifeval': r['grade'], r['ifeval_details'] = G.grade_ifeval(r)
        else: r['grade'] = 'SKIP'
        if r.get('timedOut') or r.get('error'): r['grade_note'] = 'pipeline_failure'
    except Exception as e:
        r['grade'] = 'GRADE_ERROR'; r['grade_note'] = str(e)[:200]
    return r

with ThreadPoolExecutor(max_workers=4) as ex:
    graded = list(ex.map(grade_one, recs))
with open(resdir / 'graded.jsonl', 'w') as f:
    for r in graded: f.write(json.dumps(r, ensure_ascii=False) + '\n')

from collections import Counter
print(f"{'benchmark':<12}{'n':>4}{'correct':>9}{'incorr':>8}{'not_att':>9}{'timeout':>9}{'acc%':>7}{'p50s':>7}{'p90s':>7}")
for b in ['simpleqa', 'csimpleqa', 'frames', 'gaia', 'gsm8k', 'ifeval']:
    rs = [r for r in graded if r['benchmark'] == b]
    if not rs: continue
    c = Counter(r['grade'] for r in rs)
    ms = sorted(r['ms'] for r in rs)
    p50 = ms[len(ms)//2]/1000; p90 = ms[max(0,int(len(ms)*0.9)-1)]/1000
    print(f"{b:<12}{len(rs):>4}{c['CORRECT']:>9}{c['INCORRECT']:>8}{c['NOT_ATTEMPTED']:>9}{sum(r['timedOut'] for r in rs):>9}{100*c['CORRECT']/len(rs):>7.1f}{p50:>7.1f}{p90:>7.1f}")
