# 智能体链路基准评测（bench）

无头 harness：把 Electron 壳与本地 SQLite 桩掉，其余**全部真实管线模块**（本体钩子 → 企业知识库 → 技能路由/编排 → 联网检索 → 诚实问答兜底）在纯 Node 下驱动，跑主流智能体测试集并逐题判分。与 `scripts/eval-router`、`scripts/eval-ontology` 同一哲学：改路由/检索/合成后一键回归，防过拟合单条 badcase。

历史结论见 `docs/agent-bench-report-*.md`（Round 1/2/3）。

## 依赖

- 后端在跑（默认 `http://localhost:8080`）：模型网关 + 检索代理（SearXNG/HYBRID）。
- 一个可登录的客户端账号（dev 种子：`kang/kang123`）→ 换取 JWT。
- Python 3（判分器用 stdlib + `pyarrow` 仅在重新抽样 GAIA 时需要）。

## 跑法

```bash
# 1) 取 JWT（dev 环境）
JWT=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"kang","password":"kang123"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 2) 打包 + 跑（150 题；支持断点续跑——中断后重跑会跳过已完成项）
BENCH_JWT=$JWT \
BENCH_EXPERT_ID=expert-1781625723384 BENCH_EXPERT_NAME=销售 \
BENCH_BOUND_SKILLS='["skill-imp-4a954f92","skill-imp-3eb6c86e", ...]' \
BENCH_WORKSPACE=/tmp/bench-ws BENCH_DATA_DIR=/tmp/bench-ws \
BENCH_CONC=2 BENCH_TIMEOUT_MS=360000 \
npm run eval:bench

# 3) 判分（LLM 双裁判 + 程序化校验器）→ bench/results/graded.jsonl + 汇总表
python3 bench/grade.py
```

`BENCH_CONC=2` 而非更高：SearXNG 国内引擎在突发并发下会被上游 CAPTCHA 集体挂起 900s，偶发返回 0 结果污染英文事实题（后端已加空结果重试，但突发仍难完全避免）。跑完可用 `grep '搜到 0 条结果' run.log` 找残留、单独重跑那几题再拼回。

## 环境变量

| 变量 | 含义 | 默认 |
|---|---|---|
| `BENCH_JWT` | 客户端登录 JWT（检索代理鉴权） | 必填 |
| `BENCH_ADMIN_BASE` | 后端地址 | `http://localhost:8080` |
| `BENCH_CORP_KEY` | 模型网关 corp key | `sk-corp-default-key` |
| `BENCH_MODEL` | 网关模型名 | `corp-default` |
| `BENCH_EXPERT_ID` / `BENCH_EXPERT_NAME` | 岗位分身 | `expert-1781625723384` / 销售 |
| `BENCH_BOUND_SKILLS` | 该岗位装配技能 id（JSON 数组） | 空 |
| `BENCH_WORKSPACE` / `BENCH_DATA_DIR` | 产物/桩数据目录 | cwd |
| `BENCH_CONC` | 并发 | 3 |
| `BENCH_TIMEOUT_MS` | 单题超时 | 420000 |

## 文件

| 文件 | 作用 |
|---|---|
| `bench-agent.ts` | harness 入口：忠实复刻 `main.ts` 的 `agent:send-message` 编排 |
| `build.mjs` | esbuild 打包（electron→桩、`./db`→桩）→ `node_modules/.bench/bundle.mjs` |
| `stubs/stub-electron.ts` / `stubs/stub-db.ts` | 桩：离屏浏览器快速失败触发降级链；内存 KV 替 SQLite |
| `data/tasks.jsonl` | 抽样题库（SimpleQA/C-SimpleQA/FRAMES/GAIA文本/GSM8K/IFEval 各若干） |
| `sample_tasks.py` | 从原始数据集固定种子重抽样（需先下载各集，见脚本注释） |
| `grade.py` / `grade_dir.py` | 判分器：LLM 双裁判（事实题）+ 程序化校验器（GSM8K/IFEval） |
| `naked_baseline.py` | 裸模型对照组（隔离"管线增量"） |

> ⚠️ 改技能链路（`runSkillPipeline`/`runCustomSkill` 等）后，冒烟测不到行为正确性——除跑本 harness 外，仍需真跑一次读取类 + 写入类技能验证。
