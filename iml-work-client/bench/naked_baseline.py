# 对照组：同样的题直接打网关裸模型（无管线/人设/联网），隔离「管线增量」。
import json, urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

SP = Path(__file__).resolve().parent
GATEWAY = 'http://localhost:8080/api/v1/model/chat'
KEY = 'sk-corp-default-key'
MODEL = 'corp-default'
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def llm(prompt):
    body = json.dumps({'model': MODEL, 'temperature': 0, 'messages': [{'role': 'user', 'content': prompt}]}).encode()
    req = urllib.request.Request(GATEWAY, data=body, headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {KEY}'})
    for a in range(3):
        try:
            with _opener.open(req, timeout=180) as r:
                return json.load(r)['choices'][0]['message']['content'] or ''
        except Exception:
            if a == 2: return ''
    return ''

tasks = [json.loads(l) for l in open(SP / 'data' / 'tasks.jsonl')]
todo = [t for t in tasks if t['benchmark'] in ('gsm8k', 'simpleqa', 'csimpleqa')]
out_path = SP / 'results' / 'naked.jsonl'
done = set()
if out_path.exists():
    for l in open(out_path):
        r = json.loads(l); done.add(r['benchmark'] + '/' + r['id'])
todo = [t for t in todo if t['benchmark'] + '/' + t['id'] not in done]

def run(t):
    ans = llm(t['question'])
    return {'id': t['id'], 'benchmark': t['benchmark'], 'question': t['question'], 'gold': t['gold'], 'answer': ans}

with ThreadPoolExecutor(max_workers=4) as ex:
    for r in ex.map(run, todo):
        with open(out_path, 'a') as f: f.write(json.dumps(r, ensure_ascii=False) + '\n')
        print('naked ✔', r['benchmark'], r['id'])
print('done', len(todo))
