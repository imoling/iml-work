# 从 6 个基准测试集固定种子抽样，生成统一 tasks.jsonl（id/benchmark/question/gold/meta）。
import csv, json, random, sys
from pathlib import Path

import pyarrow.parquet as pq

SP = Path(__file__).resolve().parent
DATA = SP / 'data'
rng = random.Random(42)
tasks = []

# IFEval：只抽「全部指令都在已实现校验器集合内」的题（判分确定性）
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

# 1) SimpleQA（英文事实问答，需检索）
rows = list(csv.DictReader(open(DATA / 'simple_qa_test_set.csv')))
for i, r in enumerate(rng.sample(rows, 30)):
    tasks.append({'id': f'sq{i:02d}', 'benchmark': 'simpleqa', 'question': r['problem'], 'gold': r['answer']})

# 2) Chinese-SimpleQA（中文事实问答，需检索；按一级类目分层）
rows = list(csv.DictReader(open(DATA / 'chinese_simpleqa.csv')))
by_cat = {}
for r in rows: by_cat.setdefault(r['primary_category'], []).append(r)
per = max(1, 30 // len(by_cat))
picked = []
for cat in sorted(by_cat): picked += rng.sample(by_cat[cat], min(per, len(by_cat[cat])))
picked = picked[:30]
for i, r in enumerate(picked):
    tasks.append({'id': f'cq{i:02d}', 'benchmark': 'csimpleqa', 'question': r['question'], 'gold': r['answer'],
                  'meta': {'category': r['primary_category']}})

# 3) FRAMES（多跳检索推理）
rows = list(csv.DictReader(open(DATA / 'frames_test.tsv'), delimiter='\t'))
for i, r in enumerate(rng.sample(rows, 20)):
    q = r.get('Prompt') or r.get('question') or ''
    a = r.get('Answer') or r.get('answer') or ''
    tasks.append({'id': f'fr{i:02d}', 'benchmark': 'frames', 'question': q, 'gold': a,
                  'meta': {'type': r.get('reasoning_types', '')}})

# 4) GAIA 文本题（通用智能体，L1/L2）
rows = pq.read_table(DATA / 'gaia_validation.parquet').to_pylist()
textonly = [r for r in rows if not r.get('file_name')]
l1 = [r for r in textonly if r['Level'] == '1']
l2 = [r for r in textonly if r['Level'] == '2']
sel = rng.sample(l1, 12) + rng.sample(l2, 8)
for i, r in enumerate(sel):
    tasks.append({'id': f'ga{i:02d}', 'benchmark': 'gaia', 'question': r['Question'], 'gold': r['Final answer'],
                  'meta': {'level': r['Level'], 'task_id': r['task_id']}})

# 5) GSM8K（数学推理，无需检索）
rows = [json.loads(l) for l in open(DATA / 'gsm8k_test.jsonl') if l.strip()]
for i, r in enumerate(rng.sample(rows, 30)):
    gold = r['answer'].split('####')[-1].strip()
    tasks.append({'id': f'gs{i:02d}', 'benchmark': 'gsm8k', 'question': r['question'], 'gold': gold})

# 6) IFEval（指令遵循，程序化判分）
rows = [json.loads(l) for l in open(DATA / 'ifeval_input.jsonl') if l.strip()]
ok = [r for r in rows if all(i in IMPL for i in r['instruction_id_list'])]
sel = rng.sample(ok, min(20, len(ok)))
for i, r in enumerate(sel):
    tasks.append({'id': f'if{i:02d}', 'benchmark': 'ifeval', 'question': r['prompt'], 'gold': '',
                  'meta': {'key': r['key'], 'instruction_id_list': r['instruction_id_list'], 'kwargs': r['kwargs']}})

out = SP / 'data' / 'tasks.jsonl'
with open(out, 'w') as f:
    for t in tasks: f.write(json.dumps(t, ensure_ascii=False) + '\n')
from collections import Counter
print('总题数', len(tasks), Counter(t['benchmark'] for t in tasks))
print('IFEval 可判分池', len(ok), '/', len(rows))
