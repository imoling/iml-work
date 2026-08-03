# 第二套题库（防过拟合复测用）：与 sample_tasks.py 同口径、**换种子重抽**，题目与第一套不重合。
#
# 为什么要第二套：第一套 150 题反复跑了三轮以上，优化难免朝已知题面靠。换一批同分布的新题，
# 才能分辨"真的变强"与"把这 150 题记住了"。
#
# GAIA 例外——数据集是 gated（HF 401），拿不到新题，沿用第一套那 20 道。
# 这是**刻意保留的对照组**：同题同判分，正好用来看时延/超时类优化的效果（不受换题干扰）。
#
# 数据源（公开直链，见 fetch 注释）：
#   SimpleQA    openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv
#   C-SimpleQA  hf: OpenStellarTeam/Chinese-SimpleQA/chinese_simpleqa.jsonl
#   FRAMES      hf: google/frames-benchmark/test.tsv
#   GSM8K       github: openai/grade-school-math test.jsonl
#   IFEval      github: google-research/instruction_following_eval input_data.jsonl
import csv, json, random, sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/bench-src')
OUT = Path(__file__).resolve().parent / 'data' / 'tasks_v2.jsonl'
OLD = Path(__file__).resolve().parent / 'data' / 'tasks.jsonl'
rng = random.Random(2026)          # 第一套用 42；换种子即换题
csv.field_size_limit(10**7)

# 第一套已用过的题面，逐字排除（同一题在两个种子下被抽中是有可能的）
old_qs, old_gaia = set(), []
for ln in open(OLD, encoding='utf-8'):
    t = json.loads(ln)
    old_qs.add(t['question'].strip())
    if t['benchmark'] == 'gaia':
        old_gaia.append(t)

tasks = []

# IFEval：只抽「全部指令都在已实现校验器集合内」的题（判分确定性）——与第一套同一集合
IMPL = {
    'keywords:existence', 'keywords:frequency', 'keywords:forbidden_words',
    'length_constraints:number_words', 'length_constraints:number_sentences', 'length_constraints:number_paragraphs',
    'detectable_format:number_bullet_lists', 'detectable_format:title', 'detectable_format:json_format',
    'detectable_format:number_highlighted_sections', 'detectable_format:multiple_sections',
    'startend:quotation', 'startend:end_checker',
    'change_case:english_lowercase', 'change_case:english_capital', 'change_case:capital_word_frequency',
    'punctuation:no_comma', 'detectable_content:number_placeholders', 'detectable_content:postscript',
    'combination:repeat_prompt', 'combination:two_responses', 'letters:letter_counting',
}

def pick(pool, n, qkey):
    """从 pool 里剔掉第一套用过的题面，再随机取 n 条。"""
    fresh = [r for r in pool if (qkey(r) or '').strip() and (qkey(r) or '').strip() not in old_qs]
    return rng.sample(fresh, min(n, len(fresh)))

# 1) SimpleQA
rows = list(csv.DictReader(open(SRC / 'simple_qa_test_set.csv', encoding='utf-8')))
for i, r in enumerate(pick(rows, 30, lambda r: r['problem'])):
    tasks.append({'id': f'sq{i:02d}', 'benchmark': 'simpleqa', 'question': r['problem'], 'gold': r['answer']})

# 2) C-SimpleQA（按一级类目分层，与第一套同策略）
rows = [json.loads(l) for l in open(SRC / 'csqa.jsonl', encoding='utf-8') if l.strip()]
by_cat = {}
for r in rows:
    if r['question'].strip() in old_qs: continue
    by_cat.setdefault(r['primary_category'], []).append(r)
per = max(1, 30 // max(1, len(by_cat)))
picked = []
for cat in sorted(by_cat): picked += rng.sample(by_cat[cat], min(per, len(by_cat[cat])))
picked = picked[:30]
for i, r in enumerate(picked):
    tasks.append({'id': f'cq{i:02d}', 'benchmark': 'csimpleqa', 'question': r['question'], 'gold': r['answer'],
                  'meta': {'category': r['primary_category']}})

# 3) FRAMES（多跳检索推理）
rows = list(csv.DictReader(open(SRC / 'frames.tsv', encoding='utf-8'), delimiter='\t'))
for i, r in enumerate(pick(rows, 20, lambda r: r.get('Prompt'))):
    tasks.append({'id': f'fr{i:02d}', 'benchmark': 'frames', 'question': r.get('Prompt', ''), 'gold': r.get('Answer', ''),
                  'meta': {'type': r.get('reasoning_types', '')}})

# 4) GAIA —— 沿用第一套（gated 拿不到新题）。刻意保留为对照组。
for t in old_gaia:
    tasks.append(t)

# 5) GSM8K
rows = [json.loads(l) for l in open(SRC / 'gsm8k_test.jsonl', encoding='utf-8') if l.strip()]
for i, r in enumerate(pick(rows, 30, lambda r: r['question'])):
    tasks.append({'id': f'gs{i:02d}', 'benchmark': 'gsm8k', 'question': r['question'],
                  'gold': r['answer'].split('####')[-1].strip()})

# 6) IFEval（程序化判分）
rows = [json.loads(l) for l in open(SRC / 'ifeval_input.jsonl', encoding='utf-8') if l.strip()]
ok = [r for r in rows if all(i in IMPL for i in r['instruction_id_list'])]
for i, r in enumerate(pick(ok, 20, lambda r: r['prompt'])):
    tasks.append({'id': f'if{i:02d}', 'benchmark': 'ifeval', 'question': r['prompt'], 'gold': '',
                  'meta': {'key': r['key'], 'instruction_id_list': r['instruction_id_list'], 'kwargs': r['kwargs']}})

with open(OUT, 'w', encoding='utf-8') as f:
    for t in tasks: f.write(json.dumps(t, ensure_ascii=False) + '\n')

from collections import Counter
overlap = sum(1 for t in tasks if t['benchmark'] != 'gaia' and t['question'].strip() in old_qs)
print('总题数', len(tasks), dict(Counter(t['benchmark'] for t in tasks)))
print('与第一套重合（GAIA 除外，应为 0）：', overlap)
print('IFEval 可判分池', len(ok), '/', len(rows))
print('输出 →', OUT)
