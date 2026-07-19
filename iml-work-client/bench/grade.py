# 判分器：读 results.jsonl → 按基准分别判分 → graded.jsonl + 汇总表。
# - simpleqa / csimpleqa：SimpleQA 官方三分类判分（LLM judge，CORRECT/INCORRECT/NOT_ATTEMPTED）
# - frames / gaia：LLM judge 对照标准答案判对错（gaia 语义等价即对，宽于官方 quasi-EM，报告注明）
# - gsm8k：程序化抽取最终数值精确匹配
# - ifeval：程序化校验器（覆盖抽样内全部 18 种指令类型）
import json, re, sys, urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

SP = Path(__file__).resolve().parent
GATEWAY = 'http://localhost:8080/api/v1/model/chat'
KEY = 'sk-corp-default-key'
MODEL = 'corp-default'

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # localhost 不走系统代理

def llm(prompt: str) -> str:
    body = json.dumps({'model': MODEL, 'temperature': 0, 'messages': [{'role': 'user', 'content': prompt}]}).encode()
    req = urllib.request.Request(GATEWAY, data=body, headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {KEY}'})
    for attempt in range(3):
        try:
            with _opener.open(req, timeout=120) as r:
                d = json.load(r)
                return d['choices'][0]['message']['content'] or ''
        except Exception:
            if attempt == 2: raise
    return ''

SIMPLEQA_GRADER = """Your job is to look at a question, a gold target, and a predicted answer, and then assign a grade of either ["CORRECT", "INCORRECT", "NOT_ATTEMPTED"].

The following are examples of CORRECT predicted answers.
Question: What are the names of Barack Obama's children?
Gold target: Malia Obama and Sasha Obama
Predicted answer: sasha and malia obama
These predicted answers are all CORRECT because they fully contain the important information in the gold target and do not contain any information that contradicts the gold target.

The following are examples of INCORRECT predicted answers.
Question: What are the names of Barack Obama's children?
Gold target: Malia and Sasha
Predicted answer: Malia, Sasha, and Susan.
These predicted answers are all INCORRECT because they contain a factual statement that contradicts the gold target.

The following are examples of NOT_ATTEMPTED predicted answers.
Question: What are the names of Barack Obama's children?
Gold target: Malia and Sasha
Predicted answer: I cannot answer / I don't have this information / I would need to search for this.
These are NOT_ATTEMPTED because the important information in the gold target is not included in the answer AND no statement contradicts the gold target.

Notes:
- The predicted answer may be in Chinese while the gold target is in English (or vice versa); translate before comparing — semantic equivalence counts as CORRECT.
- The predicted answer may be verbose (a full assistant reply with greetings and advice); grade only on whether the gold target's key information is correctly stated somewhere in it.
- If the answer says it cannot access data / recommends configuring a skill / asks the user to search themselves, and never states the gold fact, grade NOT_ATTEMPTED.
- Numbers must match to the precision given in the gold target.

Question: {question}
Gold target: {gold}
Predicted answer: {answer}

Reply with exactly one word: CORRECT, INCORRECT, or NOT_ATTEMPTED."""

EQUIV_GRADER = """Judge whether the predicted answer is correct given the gold answer. The predicted answer may be a long assistant reply (possibly in Chinese); it is correct if it clearly states the gold answer (semantic/numeric equivalence counts, translation differences are fine). If it never commits to the gold fact, or states a contradicting fact, it is wrong. If it explicitly refuses/says it cannot find out, it is "not_attempted".

Question: {question}
Gold answer: {gold}
Predicted answer: {answer}

Reply with exactly one word: CORRECT, INCORRECT, or NOT_ATTEMPTED."""

STRICT_VERIFY = """The gold answer to the question below is: "{gold}"
Here is a candidate reply. Does the reply explicitly state this gold answer (or an exact semantic / translation equivalent, e.g. Chinese rendering of the same name/number)? Rules:
- If the reply's committed answer is a DIFFERENT value/name than the gold answer, reply NO.
- If the reply only hedges ("可能/不确定/建议核实") without committing to the gold value, reply NO.
- Extra surrounding content is fine; only the committed answer matters.

Question: {question}
Candidate reply: {answer}

Reply with exactly one word: YES or NO."""

def grade_llm(rec, tpl):
    ans = (rec.get('answer') or '').strip()
    if not ans: return 'NOT_ATTEMPTED'
    out = llm(tpl.format(question=rec['question'][:2000], gold=rec['gold'], answer=ans[:6000])).strip().upper()
    grade = 'INCORRECT'
    for k in ('NOT_ATTEMPTED', 'CORRECT', 'INCORRECT'):
        if k in out: grade = k; break
    # 二次复核：CORRECT 必须通过严格验证（裁判放水实锤：「渠王」答成「阿尺」曾被判对）
    if grade == 'CORRECT':
        v = llm(STRICT_VERIFY.format(gold=rec['gold'], question=rec['question'][:2000], answer=ans[:6000])).strip().upper()
        if not v.startswith('YES'):
            grade = 'INCORRECT'
    return grade

NUM = re.compile(r'-?\d[\d,]*\.?\d*')
def grade_gsm8k(rec):
    ans = rec.get('answer') or ''
    gold = rec['gold'].replace(',', '').strip()
    nums = [n.replace(',', '').rstrip('.') for n in NUM.findall(ans)]
    if not nums: return 'NOT_ATTEMPTED'
    def eq(a, b):
        try: return abs(float(a) - float(b)) < 1e-6
        except ValueError: return False
    tail = ans[-400:]
    tail_nums = [n.replace(',', '').rstrip('.') for n in NUM.findall(tail)]
    return 'CORRECT' if any(eq(n, gold) for n in (tail_nums or nums)) else 'INCORRECT'

# ── IFEval 校验器（覆盖抽样内的 18 种指令）─────────────────────────────
def _words(t): return re.findall(r"[A-Za-z']+", t)
def _rel(count, relation, n):
    return count >= n if relation == 'at least' else count < n

def check_instruction(iid, kw, resp):
    t = resp
    if iid == 'keywords:existence':
        return all(re.search(re.escape(k), t, re.I) for k in kw['keywords'])
    if iid == 'keywords:frequency':
        c = len(re.findall(re.escape(kw['keyword']), t, re.I))
        return _rel(c, kw['relation'], kw['frequency'])
    if iid == 'keywords:forbidden_words':
        return not any(re.search(r'\b' + re.escape(k) + r'\b', t, re.I) for k in kw['forbidden_words'])
    if iid == 'length_constraints:number_words':
        return _rel(len(_words(t)), kw['relation'], kw['num_words'])
    if iid == 'length_constraints:number_sentences':
        c = len([s for s in re.split(r'[.!?]+', t) if s.strip()])
        return _rel(c, kw['relation'], kw['num_sentences'])
    if iid == 'length_constraints:number_paragraphs':
        c = len([p for p in t.split('***') if p.strip()])
        return c == kw['num_paragraphs']
    if iid == 'detectable_format:number_bullet_lists':
        c = len(re.findall(r'^\s*[\*\-]\s', t, re.M))
        return c == kw['num_bullets']
    if iid == 'detectable_format:title':
        return bool(re.search(r'<<[^\n]+>>', t))
    if iid == 'detectable_format:number_highlighted_sections':
        return len(re.findall(r'\*[^\n\*]+\*', t)) >= kw['num_highlights']
    if iid == 'change_case:english_capital':
        letters = re.findall(r'[A-Za-z]', t)
        return bool(letters) and all(c.isupper() for c in letters)
    if iid == 'change_case:english_lowercase':
        letters = re.findall(r'[A-Za-z]', t)
        return bool(letters) and all(c.islower() for c in letters)
    if iid == 'change_case:capital_word_frequency':
        c = len([w for w in t.split() if re.fullmatch(r"[A-Z']{2,}", w)])
        return _rel(c, kw['capital_relation'], kw['capital_frequency'])
    if iid == 'punctuation:no_comma':
        return ',' not in t and '，' not in t
    if iid == 'detectable_content:postscript':
        m = kw['postscript_marker']
        return m.lower() in t.lower()
    if iid == 'detectable_content:number_placeholders':
        return len(re.findall(r'\[[^\[\]]+\]', t)) >= kw['num_placeholders']
    if iid == 'combination:repeat_prompt':
        return t.strip().startswith(kw['prompt_to_repeat'].strip()[:60])
    if iid == 'combination:two_responses':
        return '******' in t
    if iid == 'startend:quotation':
        s = t.strip()
        return s.startswith('"') and s.endswith('"')
    if iid == 'startend:end_checker':
        return t.strip().rstrip('"』」').endswith(kw['end_phrase'].strip().rstrip('.')) or t.strip().endswith(kw['end_phrase'].strip())
    if iid == 'detectable_format:multiple_sections':
        return len(re.findall(re.escape(kw['section_spliter']), t, re.I)) >= kw['num_sections']
    if iid == 'detectable_format:json_format':
        s = re.sub(r'^```(json)?|```$', '', t.strip(), flags=re.M).strip()
        try: json.loads(s); return True
        except Exception: return False
    return None   # 未实现（不应出现）

def grade_ifeval(rec):
    resp = rec.get('answer') or ''
    ids = rec['meta']['instruction_id_list']
    kwargs = rec['meta']['kwargs']
    details = []
    for iid, kw in zip(ids, kwargs):
        ok = check_instruction(iid, kw or {}, resp)
        details.append({'id': iid, 'pass': bool(ok)})
    all_ok = all(d['pass'] for d in details)
    return ('CORRECT' if all_ok else 'INCORRECT'), details

def main():
    results_file = SP / 'results' / 'results.jsonl'
    tasks = {}
    for l in open(SP / 'data' / 'tasks.jsonl'):
        t = json.loads(l); tasks[t['benchmark'] + '/' + t['id']] = t
    recs = []
    for l in open(results_file):
        r = json.loads(l)
        t = tasks.get(r['benchmark'] + '/' + r['id'])
        if t and 'meta' in t: r['meta'] = t['meta']
        recs.append(r)

    def grade_one(r):
        b = r['benchmark']
        try:
            if b in ('simpleqa', 'csimpleqa'): r['grade'] = grade_llm(r, SIMPLEQA_GRADER)
            elif b in ('frames', 'gaia'): r['grade'] = grade_llm(r, EQUIV_GRADER)
            elif b == 'gsm8k': r['grade'] = grade_gsm8k(r)
            elif b == 'ifeval': r['grade'], r['ifeval_details'] = grade_ifeval(r)
            else: r['grade'] = 'SKIP'
            if r.get('timedOut') or r.get('error'): r['grade_note'] = 'pipeline_failure'
        except Exception as e:
            r['grade'] = 'GRADE_ERROR'; r['grade_note'] = str(e)[:200]
        return r

    with ThreadPoolExecutor(max_workers=4) as ex:
        graded = list(ex.map(grade_one, recs))

    with open(SP / 'results' / 'graded.jsonl', 'w') as f:
        for r in graded: f.write(json.dumps(r, ensure_ascii=False) + '\n')

    from collections import Counter, defaultdict
    import statistics
    print(f"{'benchmark':<12}{'n':>4}{'correct':>9}{'incorr':>8}{'not_att':>9}{'timeout':>9}{'err':>5}{'acc%':>7}{'p50s':>7}{'p90s':>7}")
    for b in ['simpleqa', 'csimpleqa', 'frames', 'gaia', 'gsm8k', 'ifeval']:
        rs = [r for r in graded if r['benchmark'] == b]
        if not rs: continue
        c = Counter(r['grade'] for r in rs)
        ms = sorted(r['ms'] for r in rs)
        p50 = ms[len(ms)//2]/1000; p90 = ms[int(len(ms)*0.9)-1]/1000
        acc = 100*c['CORRECT']/len(rs)
        print(f"{b:<12}{len(rs):>4}{c['CORRECT']:>9}{c['INCORRECT']:>8}{c['NOT_ATTEMPTED']:>9}{sum(r['timedOut'] for r in rs):>9}{sum(1 for r in rs if r.get('error')):>5}{acc:>7.1f}{p50:>7.1f}{p90:>7.1f}")

if __name__ == '__main__':
    main()
