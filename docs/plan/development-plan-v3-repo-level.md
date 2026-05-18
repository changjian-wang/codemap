# CodeMap 开发计划 v3（仓库级 / Chat-first / UML）

> **状态**：active。supersedes [`development-plan-v2-single-file.md`](./development-plan-v2-single-file.md)。
> **产品形态基准**：[`../mockups/lumen-backend-v3.html`](../mockups/lumen-backend-v3.html)。
> **一句话定位**：在 VS Code Copilot Chat 里输入 `@codemap`，对**整个仓库**生成可信、可读、可追问的 UML 调用图谱。

---

## v3 相对 v2 的核心变化

| # | v2（单文件 MVP） | v3（仓库级 MVP） | 原因 |
|---|---|---|---|
| 1 | 节点 = 类/方法/函数（混合）| **节点 = 类，方法在节点内**（UML 风格）| 仓库级几千符号，方法粒度会爆图；类是天然的可读单元 |
| 2 | 入口 = command `Analyze Current File` | **入口 = Chat Participant `@codemap`** | 仓库级必须支持范围裁剪与跨 turn 追问，命令面板做不到 |
| 3 | LLM 一次流式分析单文件 | **分治：扫描器 → N 个单文件 analyzer 并行 → 聚合器跨文件补边** | 整仓不可能塞进任一上下文窗口 |
| 4 | LSP = `executeDocumentSymbolProvider` | LSP = symbol provider **+ `executeWorkspaceSymbolProvider`**（跨文件解析）| 跨文件 calls 必须用 workspace symbol 解析 |
| 5 | Eval 指标：节点 P/R | **节点 P/R + 边 P/R 并列**（边是仓库级主难点）| 边召回 < 节点召回，是 prompt 调优的真信号 |
| 6 | 验证三态 verified/partial/unverified | 三态保留 | v2 这条不变量直接继承 |
| 7 | 4 周 / 70-90 小时 | **5 周 / ~90-110 小时**（多了扫描器 + 聚合器）| 物理必然 |

---

## 一、产品愿景

AI 代码生成速度 ≫ 人类阅读速度。`@codemap 帮我生成 X 仓库的 codemap` 之后，用户应该在 30-60 秒内看到：

1. **类节点 UML 图**（按 bounded context 分色），不是文件树也不是 mermaid
2. **建议阅读顺序**（从入口 / Controller 向下展开），节点上有编号徽标
3. **风险标注**（security / external_io / concurrency / low_confidence …）
4. **三态验证视觉**（verified 实线、partial 虚线、unverified 灰点线 + 禁跳转）
5. **节点点开**：方法列表、每个方法可展开看 intent + calls + risks
6. **追问**：在 chat 里继续 `/scope`、`/focus`、`/why partial X`

不变量从 v2 继承：

> "图必须准" 与 "能用" 同级。任何让用户怀疑图的可信度的功能，宁可不做，也不要做错。

---

## 二、MVP v1.0 范围（必做）

- ✅ Chat Participant `@codemap`，**默认 turn**：分析整个 workspace
- ✅ 支持 **TypeScript / JavaScript** 和 **C#**（lumen 是 dogfood 目标，必须能跑通）
- ✅ 调 GitHub Copilot 模型（`vscode.lm`），零 API key
- ✅ Workspace scanner：ripgrep 列文件 + 按 import / using BFS 选骨架 ≤ 30 个文件
- ✅ 并行 single-file analyzer（每个文件一个 `vscode.lm` 调用）
- ✅ LSP 校准层（symbol + workspace symbol）
- ✅ 聚合器：跨文件 calls 解析、external_calls 软校验
- ✅ WebView Panel：Cytoscape.js + dagre，UML 类节点（类名 + 方法列表 + verification glyph）
- ✅ 节点按 bounded context 染色（≤ 4 个 context，靠目录启发式推断）
- ✅ 三态 verification UI（实线 / 虚线 / 灰点线）
- ✅ 节点点击 → 右侧详情卡（含方法可展开）
- ✅ 跳源码 fallback 链（v2 §7.6 直接复用）
- ✅ "Mark read" + 阅读进度持久化（`workspaceState`）
- ✅ Chat 范围裁剪命令：`/scope <path>`、`/focus <ClassName>`、`/explain unverified`
- ✅ Eval：`pnpm eval` 跑 golden samples，输出节点 + 边的 P/R/F1
- ✅ 暗/亮主题适配

## 三、不在 MVP 范围

- ❌ 方法级 drill-down 子图（v1.1）—— 当前所有方法在类节点内即可
- ❌ Python / Go / Rust（v1.1+）
- ❌ git diff / PR 范围分析（v1.2）
- ❌ 图导出 PNG / SVG / Mermaid（v1.2）
- ❌ Chat 里直接渲染图（物理不可达；图永远在 WebView Panel）
- ❌ 全量符号扫描（始终只对 ≤ 30 个骨架文件做 LLM 分析）

---

## 四、技术架构

```
User: @codemap 帮我生成 X 仓库的 codemap
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│  Chat Participant (vscode.chat.createChatParticipant)         │
│   - parse intent: full repo / scoped / focus class / etc.     │
│   - stream progress markdown back into chat                   │
│   - on complete: open / focus WebView Panel                   │
└──────────────┬────────────────────────────────────────────────┘
               │
               ▼
┌───────────────────────────────────────────────────────────────┐
│  Orchestrator (src/orchestrator/)                              │
│                                                                │
│  1. WorkspaceScanner                                           │
│     - ripgrep entry points (Program.cs / Main / index.ts /…)  │
│     - BFS via import/using, depth ≤ 3, cap ≤ 30 files          │
│     - bucket files into bounded contexts (dir heuristics)     │
│                                                                │
│  2. Parallel SingleFileAnalyzer (one per file)                 │
│     - vscode.lm streamAnalyze → raw codemap-meta blocks       │
│     - calibrator (per-file)                                    │
│                                                                │
│  3. Aggregator                                                 │
│     - merge nodes (one class = one node)                       │
│     - resolve cross-file calls via                             │
│       executeWorkspaceSymbolProvider                           │
│     - softly validate external_calls                           │
│     - compute reading order over the merged graph             │
└──────────────┬────────────────────────────────────────────────┘
               │ ServerEvent stream
               ▼
┌───────────────────────────────────────────────────────────────┐
│  WebView Panel (Cytoscape + dagre + React)                     │
│   - render UML class nodes (label = name + methods + ✓⚠✗)     │
│   - three-state verification visuals                           │
│   - method-row expand (per the v3 mockup)                      │
│   - chat panel mirrors the same conversation                   │
└───────────────────────────────────────────────────────────────┘
```

### 4.1 数据流

```
chat request
    │
    ▼
WorkspaceScanner ── 30 files + bucketed contexts
    │
    ▼ parallel
SingleFileAnalyzer × N ── raw codemap-meta blocks
    │
    ▼
Calibrator (per file) ── verified / partial nodes
    │
    ▼
Aggregator ── one class = one node, cross-file edges resolved
    │
    ▼
GraphEngine ── reading order, dedup, external dep nodes
    │
    ▼ ServerEvent
WebView ── UML render
```

---

## 五、关键设计决策

### 5.1 节点粒度（Q1）—— 类为节点，方法在节点内

- 每个类一个 cytoscape 节点；label 由 `ClassName + ✓⚠✗` + 分隔线 + 方法列表组成
- 方法超过 5 个折叠为 `… +N more`
- 详情卡里方法可逐行展开（v3 mockup 已定）
- **不做**方法级跨节点子图（v1.1 再说）

### 5.2 Chat 角色（Q2）—— 编排入口 + 范围裁剪 + 追问

- 第一次 `@codemap` 触发整仓分析；分析完成后自动打开 / 聚焦 WebView Panel
- 后续 turn 都可以在 chat 里发生：
  - `/scope apps/api/src/Capture` —— 只重分析该目录
  - `/focus IngestUrlHandler` —— 围绕该类向外扩展 1 跳
  - `/why partial X` —— 解释 X 为何 partial（calibrator 输出的 droppedCalls 摆出来）
  - `/explain unverified` —— 列出所有 unverified 节点的成因
- chat 与 WebView 通过 `workspaceState` 共享当前图引用，两边一致

### 5.3 Eval 指标（Q3）—— 节点 + 边 P/R 都要

| 指标 | MVP 目标 | v1.1 目标 |
|---|---|---|
| 节点 precision | ≥ 0.90 | ≥ 0.95 |
| 节点 recall    | ≥ 0.85 | ≥ 0.90 |
| **边 precision** | **≥ 0.80** | ≥ 0.90 |
| **边 recall**    | **≥ 0.75** | ≥ 0.85 |
| 跳源码命中率   | 100% | 100% |

边的指标专门拉低，因为仓库级最大挑战在跨文件边的召回。

### 5.4 三态 verification（v2 不变量直接继承）

- **verified**：符号 + 行号 + 所有 calls 都被 LSP 解析到
- **partial**：符号被解析，但 ≥ 1 个 calls 或 external_calls 落空
- **unverified**：连符号本身都找不到（虚节点，灰色点线，**禁跳转**）

### 5.5 Bounded context 推断（启发式，不上 LLM）

- C# / .NET：按 csproj 名拆。`Lumen.Modules.Capture` → context `capture`，`Lumen.Shared.*` → `shared`
- TS / monorepo：按 `packages/<name>` 或 `apps/<name>` 拆
- 同色组规则：≤ 4 个色组，超过则按 module 第一段聚合
- **决策**：MVP 不用 LLM 推 context，避免又一个不可校验的输出

---

## 六、数据模型

```typescript
// src/shared/types.ts
export type NodeKind = 'class';  // v3 MVP only — methods are nested inside
export type VerificationState = 'verified' | 'partial' | 'unverified';
export type EdgeKind = 'calls' | 'external_calls';

export interface MethodInfo {
  name: string;
  signature: string;
  line: number;
  risks: string[];          // risk type tags
  intent?: string;          // optional per-method intent
  calls?: string[];         // method-level calls (for expand panel)
  externalCalls?: string[];
}

export interface CodeNode {
  id: string;                // unique class name; e.g. "IngestUrlHandler"
  kind: NodeKind;
  file: string;
  range: { startLine: number; endLine: number };
  boundedContext: string;    // "capture" | "recall" | "host" | "shared" | ...
  intent: string;
  layer?: 'entry' | 'controller' | 'service' | 'repo' | 'util';
  confidence: number;
  risks: { type: string; desc: string }[];
  methods: MethodInfo[];
  readingPriority?: number;
  readState: 'unread' | 'reading' | 'read';

  verification: VerificationState;
  verificationDetails?: {
    rangeAdjusted: boolean;
    droppedCalls: string[];
    droppedExternalCalls: string[];
    reason?: string;
  };
}

export interface CodeEdge {
  from: string;              // class id
  to: string;                // class id, or "ext:<package>"
  kind: EdgeKind;
  verified: boolean;
}

export interface CodeMapGraph {
  rootRequest: string;       // original chat prompt
  scope: string;             // e.g. "workspace" | "apps/api/src/Capture"
  nodes: Record<string, CodeNode>;
  edges: CodeEdge[];
  externalDeps: { name: string; kind: 'package' | 'bcl' }[];
  rootIntent?: string;
  narrative?: string;
  suggestedEntryNodes?: string[];
  readingOrder?: string[];
  eval?: {
    nodes: { precision: number; recall: number; f1: number };
    edges: { precision: number; recall: number; f1: number };
  };
}
```

### 6.1 LLM 输出契约（单文件 analyzer）

每个文件分析时，prompt 要求 LLM 对每个 **class** 输出一个 `codemap-meta` 块（method 在 class 内嵌）：

````markdown
```codemap-meta
{
  "node_id": "IngestUrlHandler",
  "file": "apps/api/src/Lumen.Modules.Capture/Features/IngestUrl/IngestUrlHandler.cs",
  "range": { "startLine": 13, "endLine": 240 },
  "intent": "URL canonicalize → 去重 → 写 capture_jobs → worker 异步执行",
  "layer": "service",
  "confidence": 0.9,
  "methods": [
    {
      "name": "EnqueueAsync",
      "signature": "(IngestUrlRequest, ct)",
      "line": 49,
      "intent": "ADR-029 Layer 1 in-flight dedup + UNIQUE 索引兜底",
      "calls": ["UrlCanonicalizer.Canonicalize", "CaptureJobStore.FindInFlight..."],
      "external_calls": [],
      "risks": ["concurrency"]
    }
  ],
  "calls": ["CaptureJobStore"],              // class-level: 本文件内调用的其它类
  "external_calls": ["Dawning.ORM.Dapper"],  // 跨包 / 跨 csproj
  "risks": [{"type": "concurrency", "desc": "..."}],
  "reading_priority": 3
}
```
````

**硬约束**（同 v2 §7.5，强化）：
- `calls` 只能列**本文件 / 本 csproj** 内的类名
- `external_calls` 列跨包标识符
- 不确定不要列，列了瞎编的会被 calibrator 静默丢弃，太多丢弃整节点会被标 `partial`

---

## 七、目录结构

```
codemap/
├── docs/
│   ├── mockups/                            # locked UI references
│   │   ├── lumen-backend-v3.html
│   │   └── generic-repo-v3.html
│   ├── plan/
│   │   └── development-plan-v3-repo-level.md   # this file
│   └── adrs/
│       ├── 001-repo-level-mvp.md
│       ├── 002-class-as-node-uml.md
│       ├── 003-chat-as-orchestrator.md
│       └── 004-calibration-layer.md
├── package.json
├── tsconfig.json
├── esbuild.js
├── src/
│   ├── extension.ts                        # activation + chat registration
│   ├── shared/types.ts                     # contracts shared with webview
│   ├── chat/
│   │   ├── participant.ts                  # @codemap registration
│   │   ├── intent-router.ts                # parse / scope / focus / etc.
│   │   └── progress-stream.ts              # markdown updates into chat
│   ├── orchestrator/
│   │   ├── workspace-scanner.ts            # ripgrep + BFS, ≤30 files
│   │   ├── bc-classifier.ts                # bounded context heuristic
│   │   ├── single-file-analyzer.ts         # vscode.lm + stream parser
│   │   ├── parallel-runner.ts              # promise pool ≤ 6
│   │   └── aggregator.ts                   # merge + cross-file edges
│   ├── llm/
│   │   ├── client.ts                       # vscode.lm wrapper
│   │   ├── prompts.ts                      # class-as-node prompt (v3)
│   │   └── stream-parser.ts
│   ├── calibration/                        # ⭐ v2 inheritance
│   │   ├── symbol-index.ts
│   │   ├── workspace-symbol-resolver.ts    # NEW for v3
│   │   └── calibrator.ts
│   ├── graph/
│   │   ├── engine.ts
│   │   └── reading-order.ts
│   ├── webview/
│   │   ├── panel.ts
│   │   └── ui/                             # mirrors lumen-backend-v3.html
│   │       ├── App.tsx
│   │       ├── GraphView.tsx
│   │       ├── NodeCard.tsx
│   │       ├── MethodList.tsx              # expand/collapse rows
│   │       └── ChatMirror.tsx              # echoes the chat thread
│   └── editor/
│       └── jump-to-source.ts               # 4-level fallback (v2 §7.6)
├── eval/
│   ├── samples/
│   │   ├── lumen-mini/                     # subset of lumen apps/api
│   │   ├── express-server/                 # mid-size TS
│   │   └── auth-ts/                        # small TS
│   ├── golden/
│   ├── runs/
│   ├── score.ts                            # node + edge P/R/F1
│   └── README.md
├── test/
│   ├── unit/
│   │   ├── workspace-scanner.test.ts
│   │   ├── bc-classifier.test.ts
│   │   ├── aggregator.test.ts
│   │   ├── calibrator.test.ts
│   │   └── reading-order.test.ts
│   └── integration/
│       └── extension.test.ts
└── README.md
```

---

## 八、5 周开发计划

### Phase 0 — 环境（0.5 天）

| # | 任务 | 验收 |
|---|---|---|
| 0.1 | `yo code` 生成 TS 扩展骨架，迁到本 repo | F5 进调试主机 |
| 0.2 | esbuild 双产物（extension + webview） | 一次 build 两份 |
| 0.3 | 确认 Copilot Chat 与 `vscode.lm` 可用 | `vscode.lm.selectChatModels` 返回 ≥ 1 |

### Week 1 — 数据模型 + Chat 骨架 + 假数据 UI

**目标**：把 v3 mockup 的 UI 移植成 React + Cytoscape 组件，喂手写 JSON 跑通。

| # | 任务 | 产出 | 工时 |
|---|---|---|---|
| 1.1 | 定义 `shared/types.ts`（v3 全套类型）| 类型导出可用 | 1h |
| 1.2 | 注册 Chat Participant `@codemap` | chat 里能看到该 participant | 1.5h |
| 1.3 | Chat intent router（parse `/scope` `/focus` `/why` `/explain`） | 单元测试覆盖每个意图 | 2h |
| 1.4 | 创建 WebView Panel + 双向消息协议 | extension ↔ webview ping/pong | 2h |
| 1.5 | 移植 v3 mockup → React 组件（GraphView / NodeCard / MethodList） | 渲染手写 JSON | 6h |
| 1.6 | 三态 verification CSS（实线/虚线/灰点线）+ bc 染色 | 与 mockup 像素级一致 | 2h |
| 1.7 | 方法行可展开（MethodList 复刻 mockup `method-item` 行为）| 点 + 展开/收起 | 2h |
| 1.8 | 阅读路径算法 + 单测 | `reading-order.test.ts` ≥ 3 case | 2h |
| 1.9 | Chat 输出与 WebView 共享当前 graph（workspaceState）| 关闭 panel 再打开图还在 | 1h |

🎯 **W1 验收**：`@codemap demo` 用 fixture 数据 → chat 提示完成 → 自动打开 WebView → 看到 lumen 后端示意图水平的 UI。

### Week 2 — Workspace Scanner + 单文件 Analyzer + Calibrator

**目标**：能对真实小项目（≤ 5 文件）跑通 scanner → analyzer → calibrator，节点先单文件再聚合。

| # | 任务 | 产出 | 工时 |
|---|---|---|---|
| 2.1 | `WorkspaceScanner`：ripgrep 找入口（Main/Program/index*/handler 注解） | 单测：lumen 仓库返回 Program.cs + Endpoints | 3h |
| 2.2 | Import / using BFS 选骨架，depth ≤ 3，cap ≤ 30 | 命中率单测 ≥ 80% | 3h |
| 2.3 | `bc-classifier`：按目录 / csproj / package 启发式 | 4 个 lumen 模块全部正确分桶 | 2h |
| 2.4 | `vscode.lm` 封装 `llm/client.ts`（流式 + 取消）| e2e 调通 GPT-4o | 1.5h |
| 2.5 | v3 prompt（class-as-node + nested methods + 硬约束） | `prompts.ts` 写好 | 2.5h |
| 2.6 | `stream-parser.ts`：跨 chunk 提取 `codemap-meta` | 单测覆盖跨 chunk / 嵌套引号 / 损坏 | 2h |
| 2.7 | `SingleFileAnalyzer` 串起 client + parser + 单文件 calibrator | 单测：fake LM 输入 → graph fragment | 2h |
| 2.8 | `calibrator.ts`（含 method 行号校准）| 单测覆盖：偏移 / 缺失 / 部分丢失 | 3h |
| 2.9 | `ParallelRunner` 控并发 ≤ 6 | 30 文件并发跑不爆 token rate | 1.5h |

🎯 **W2 验收**：对 5 个手挑 lumen 文件（CaptureEndpoints / IngestUrlHandler / EventStore / RecallEndpoints / AskByQueryHandler）跑完整 pipeline，5 个类节点 + 内嵌方法都出现在 UI 上，三态正确。

### Week 3 — Aggregator + 跨文件边 + Chat 进度流

**目标**：仓库级首屏。`@codemap 帮我生成 lumen 后端的 codemap` 真能跑通。

| # | 任务 | 产出 | 工时 |
|---|---|---|---|
| 3.1 | `WorkspaceSymbolResolver`：`executeWorkspaceSymbolProvider` 缓存 | 跨文件解析 ≤ 200ms / class | 2h |
| 3.2 | `Aggregator`：合并节点（同类名去重）、补跨文件边 | 单测 fixture：3 文件合一图 | 4h |
| 3.3 | external_calls 软校验（用 `executeDefinitionProvider`） | 找不到 → partial（不丢弃节点） | 2h |
| 3.4 | Reading order 跨整图（不是单文件）计算 | 入度 0 优先 + risk 加权 | 2h |
| 3.5 | Chat progress stream（5 步打勾，对应 mockup 的 action-trace） | 真的能在 chat 里看到打勾过程 | 2h |
| 3.6 | `extension.ts` 串起 Chat Participant → Orchestrator → Panel | e2e 一气呵成 | 2h |
| 3.7 | 流式渲染：每个 analyzer 完成立即 emit ServerEvent | 节点一个个 pop 进图 | 2h |
| 3.8 | 错误兜底：模型不可用 / 用户取消 / 配额耗尽 | 友好 toast + chat 红字 | 1.5h |
| 3.9 | 对 lumen 后端实跑一次，拿 baseline 分数 | 节点 P/R + 边 P/R 数字 | 1.5h |

🎯 **W3 验收**：在装了本插件的 VS Code 里，对 lumen 工作区打 `@codemap 帮我生成 lumen 后端 codemap` → 30-60 秒看到 v3 mockup 同形态的图，跳源码命中率 = 100%。

### Week 4 — Eval + Prompt 调优 + Chat 命令

**目标**：从"能跑"到"准确"。

| # | 任务 | 产出 | 工时 |
|---|---|---|---|
| 4.1 | `eval/score.ts`：节点 + 边 P/R/F1 | 跑 fixture 出数字 | 2h |
| 4.2 | 3 个 golden samples（lumen-mini / express / auth-ts） | 手工 expected.json | 4h |
| 4.3 | Prompt 调优轮 1 — 节点召回 | 节点 R 上 0.85 | 2h |
| 4.4 | Prompt 调优轮 2 — 边精度（calls vs external_calls 分流）| 边 P 上 0.80 | 2h |
| 4.5 | Prompt 调优轮 3 — 边召回 | 边 R 上 0.75 | 2h |
| 4.6 | Chat 命令实现 `/scope <path>` | 重新跑 scanner 限定子树 | 2h |
| 4.7 | Chat 命令实现 `/focus <Class>` | 围绕该类 ±1 跳重出图 | 2h |
| 4.8 | Chat 命令实现 `/why partial X` 与 `/explain unverified` | 把 calibrator 输出按人话回 chat | 2h |
| 4.9 | 跳源码 fallback 链（v2 §7.6 移植 + 适配 C# / TS） | 错位率 = 0（手测 20 次）| 2h |
| 4.10 | 持久化：图、阅读进度按 workspace + rev hash 存 | 重启 VS Code 状态保留 | 1.5h |

🎯 **W4 验收**：`pnpm eval` 节点 P/R ≥ 0.90/0.85，边 P/R ≥ 0.80/0.75；Chat 4 个命令全部可用；跳源码 0 错位。

### Week 5 — 打磨 + 内测 + 发布

| # | 任务 | 产出 | 工时 |
|---|---|---|---|
| 5.1 | UI 视觉打磨（配色、间距、对照 mockup 走一遍）| 截图发出去不丢人 | 3h |
| 5.2 | 暗 / 亮主题适配收尾 | 全场景测试 | 1.5h |
| 5.3 | Minimap 真正实现（mockup 是占位）| 200×130 缩略图同步 viewport | 2h |
| 5.4 | 错误边界 + 友好错误消息 | 不让用户看到红色堆栈 | 1.5h |
| 5.5 | README + 截图 / GIF / 1 min demo | 仓库首页好看 | 3h |
| 5.6 | `docs/adrs/` 补 4 个核心 ADR（仓库级 / 类节点 / chat 编排 / 校准）| 4 份 markdown | 2.5h |
| 5.7 | `vsce package` 出 `.vsix` | 可分发 | 0.5h |
| 5.8 | 内测：3-5 位同事在自己仓库上跑一次 | 反馈表 | — |
| 5.9 | P0 bug 修复（≥ 1 轮）| issue 关闭 | 2-4h |
| 5.10 | 可选：发布到 VS Code Marketplace | publisher token + `vsce publish` | 1h |

🎯 **W5 验收**：内测中**跳源码错位率 = 0**；至少 1 位同事反馈"生成图后比纯读代码省了 30%+ 时间"。

---

## 九、风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 单仓 30 文件并发触发 LM rate limit | 中 | 高 | `ParallelRunner` 并发 ≤ 6 + 重试退避 |
| 跨 csproj `executeWorkspaceSymbolProvider` 不返回结果 | 中 | 中 | 软校验降级为 `partial`，UI 一等可见 |
| C# `dotnet` LSP 冷启动慢（首次几秒到几十秒）| 中 | 中 | 第一次分析前等 LSP 就绪；超时降级为"全部 unverified"+ 提示重跑 |
| 大仓（> 1000 文件）骨架选不准 | 中 | 高 | scanner 给出"选了哪些"列表，chat 里允许 `/scope` 校正 |
| Bounded context 启发式分错 | 高 | 低 | UI 允许手动改 bc tag；分错时只是配色不准，不影响图正确性 |
| Prompt 调优进度跟不上 | 中 | 中 | golden samples 提前到 W2 末尾就铺，W3 跑 baseline，W4 集中调 |
| Chat command 与 panel 状态不同步 | 中 | 中 | 共享单一 `workspaceState` key，所有 mutate 走同一 reducer |
| LLM 编造类（如 v3 mockup 里的 GroundedAskPromptsV2）| 高 | 低（已解决） | calibrator 标 unverified，UI 灰色禁跳转，chat `/why` 自动解释 |

---

## 十、不变量（继承 v2，强化）

1. **没有未校准的节点会在 UI 上看似正常** —— `verification` 字段从 W1 在类型里，UI 从 W1 就区分三态
2. **没有 prompt 调优是凭感觉做的** —— `eval/` 在 W2 末尾就建好，W3 跑 baseline，W4 每改一次跑一次
3. **没有跳转会静默跳错位置** —— jump-to-source 4 级 fallback 在 W4 实现，W5 内测时手测
4. **没有"看起来对但其实没校验"的边** —— 边的 `verified` 字段是一等输出，UI 必须区分实线 / 灰虚线
5. **Chat 与 WebView 永远显示同一张图** —— 单一 state owner（`workspaceState`），所有 mutate 走 reducer

任一改动违反上述五条之一 → 改动先停下来，重新设计。

---

## 十一、参考

### 来自 v2 仍有效
- [VS Code Extension API](https://code.visualstudio.com/api)
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [vscode-extension-samples / chat-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-sample)
- [Cytoscape.js](https://js.cytoscape.org/) + [cytoscape-dagre](https://github.com/cytoscape/cytoscape.js-dagre)

### v3 新增
- [Chat Participant API](https://code.visualstudio.com/api/extension-guides/chat) — `@codemap` 注册
- [`executeWorkspaceSymbolProvider`](https://code.visualstudio.com/api/references/commands) — 跨文件解析
- [VS Code WebView UX guidelines](https://code.visualstudio.com/api/ux-guidelines/webviews)

### 本 repo 内
- 产品形态基准：[`../mockups/lumen-backend-v3.html`](../mockups/lumen-backend-v3.html)
- 被取代的 v2 计划：[`./development-plan-v2-single-file.md`](./development-plan-v2-single-file.md)

---

## 附录 A — 每周交付物速览

| 周次 | 关键交付 | 度量 | 可演示？ |
|---|---|---|---|
| W1 | 假数据 UI 与 mockup 等价、Chat 注册、消息协议 | — | ✅ 静态 |
| W2 | scanner + 单文件 analyzer + calibrator，5 文件能出图 | 单测覆盖率 ≥ 70% | ✅ 局部 |
| W3 | Aggregator + 跨文件边，仓库级首屏 | 跑 lumen 拿 baseline | ✅ 端到端 |
| W4 | Eval 达标 + 4 个 chat 命令 + 0 跳错位 | 节点 P/R ≥ 0.90/0.85，边 ≥ 0.80/0.75 | ✅ 可信 |
| W5 | 视觉打磨 + ADR + `.vsix` + 内测 | 错位率 = 0 | ✅ 可分享 |

## 附录 B — 与 v2 的对照

| 维度 | v2 | v3 |
|---|---|---|
| 节点 | 方法 / 类混合 | 类（方法嵌入）|
| 入口 | command | Chat Participant `@codemap` |
| 分析单位 | 单文件 | 仓库（scanner 选骨架）|
| LSP | DocumentSymbol | + WorkspaceSymbol |
| Eval | 节点 P/R | 节点 + 边 P/R |
| 工期 | 4 周 | 5 周 |
| 跳源码 | 4 级 fallback | 同左 |
| 三态验证 | ✓ | ✓（不变量继承）|

---

> 建议：本文档作为活文档。完成的任务前加 ✅，进行中加 🔄，遇阻加 ⚠。每周五更新一次。
