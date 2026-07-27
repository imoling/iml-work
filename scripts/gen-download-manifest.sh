#!/usr/bin/env bash
# 生成客户端下载清单（多产品）：扫 iml-work-client/release/ 与 iml-fde-studio/release/ 的 dmg/exe
# → manifest.json（products 结构）。管理端「客户端下载」页读取此清单渲染。
# 发布：把两处安装包与本清单一起放到服务器 /opt/iml/frontend/downloads/。
set -e
cd "$(dirname "$0")/.."
python3 - <<'PY'
import json, os, datetime

PRODUCTS = [
    # (key, 展示名, 项目目录)
    ('client', 'iML Work 客户端', 'iml-work-client'),
    ('fde',    'iML FDE 工作台',  'iml-fde-studio'),
]

def scan(reldir):
    files = []
    if not os.path.isdir(reldir):
        return files
    for f in sorted(os.listdir(reldir)):
        if not (f.endswith('.dmg') or f.endswith('.exe')):
            continue
        size = os.path.getsize(os.path.join(reldir, f))
        if f.endswith('.dmg'):
            arch = 'Apple Silicon' if 'arm64' in f else 'Intel'
            files.append({'platform': 'mac', 'arch': arch, 'file': f, 'sizeBytes': size})
        else:
            files.append({'platform': 'windows', 'arch': 'x64', 'file': f, 'sizeBytes': size})
    return files

products = []
for key, name, proj in PRODUCTS:
    ver = json.load(open(os.path.join(proj, 'package.json')))['version']
    files = scan(os.path.join(proj, 'release'))
    if files:
        products.append({'key': key, 'name': name, 'version': ver, 'files': files})
    else:
        print(f'⚠ {proj}/release 无安装包，跳过 {name}')

mf = {'updatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), 'products': products}
open('downloads-manifest.json', 'w').write(json.dumps(mf, ensure_ascii=False, indent=2))
print(json.dumps(mf, ensure_ascii=False, indent=2))
print('\n→ 已写 downloads-manifest.json（发布时改名 manifest.json 放 /opt/iml/frontend/downloads/）')
PY
