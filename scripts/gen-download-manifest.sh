#!/usr/bin/env bash
# 生成客户端下载清单：扫 iml-work-client/release/ 的 dmg/exe → downloads-manifest.json
# 管理端「客户端下载」页读取此清单渲染（发布时与安装包一起放到 nginx 的 /downloads/）。
set -e
cd "$(dirname "$0")/../iml-work-client"
VER=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
python3 - "$VER" <<'PY'
import json, os, sys, datetime
ver = sys.argv[1]
files = []
for f in sorted(os.listdir('release')):
    if not (f.endswith('.dmg') or f.endswith('.exe')): continue
    size = os.path.getsize(os.path.join('release', f))
    if f.endswith('.dmg'):
        arch = 'Apple Silicon' if 'arm64' in f else 'Intel'
        files.append({'platform': 'mac', 'arch': arch, 'file': f, 'sizeBytes': size})
    else:
        files.append({'platform': 'windows', 'arch': 'x64', 'file': f, 'sizeBytes': size})
mf = {'version': ver, 'updatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), 'files': files}
open('release/manifest.json', 'w').write(json.dumps(mf, ensure_ascii=False, indent=2))
print(json.dumps(mf, ensure_ascii=False, indent=2))
PY
