# CodeMap VS Code 插件 —— 开发计划 v2

> **项目代号**：CodeMap
> **一句话定位**：在 AI 生成代码的过程中（或之后），同步产出"调用图谱 + 阅读顺序 + 意图/风险标注"，让人类 review 速度跟上 AI 生成速度。
> **最终交付物（MVP v1.0）**：可安装的 VS Code 扩展，为单个 **TypeScript/JavaScript** 文件生成交互式调用图谱 + 阅读顺序 + 风险标注，基于 `vscode.lm` API 调用 GitHub Copilot 背后的 LLM。
> **预计工期**：4 周（兼职 1~2 小时/天，约 70~90 小时）

---

## v2 相比 v1 的核心变化

| # | 变化 | 原因 |
|---|---|---|
| 1 | **把"图必须准"列为一等约束**（与"能用"同级） | 一次跳错位置或一条幻觉调用，用户对整张图的信任就会崩塌；准确性是产品价值的前提，不是优化项 |
| 2 | **插入 LSP 校准层** `src/calibration/`，所有 LLM 输出经校准才能进图 | 把"信任 LLM 输出"这条 v1 假设撤掉；用 VS Code 内置 `executeDocumentSymbolProvider` / `executeDefinitionProvider` 做确定性校验 |
| 3 | **MVP 语言收窄到 TypeScript/JavaScript** | VS Code 内置 TS LSP 最稳；Python 推到 v1.1，避免一次踩两种语言的坑 |
| 4 | **W2 末尾建 golden test** `eval/` | prompt 调优需要可度量的 precision/recall，否则就是凭感觉 |
| 5 | **Prompt 增加 `external_calls` 字段 + 硬约束** | 区分"看得到的本文件调用"和"跨文件调用"，让校准器能判幻觉 |
| 6 | **跳源码改为 fallback 链**（range → DocumentSymbol → 文本搜索 → 友好失败） | 静默跳错位比报错还伤信任 |
| 7 | **`CodeNode` 新增 `verification` 字段**（verified / partial / unverified），UI 一等展示 | 准确性不是"让 LLM 别乱说"，而是"用户能一眼看出哪些可信" |

---

## 目录

1. [产品愿景与 MVP 范围](#一产品愿景与-mvp-范围)
2. [技术架构](#二技术架构)
3. [技术选型](#三技术选型)
4. [数据模型](#四数据模型核心契约)
5. [目录结构](#五目录结构)
6. [详细开发计划（4 周）](#六详细开发计划4-周)
7. [关键代码示例](#七关键代码示例)
8. [测试与验收](#八测试与验收)
9. [风险与应对](#九风险与应对)
10. [后续路线图（v2+）](#十后续路线图v2)
11. [参考资料](#十一参考资料)

---

## 一、产品愿景与 MVP 范围

### 1.1 解决的问题
AI 代码生成速度 ≫ 人类阅读速度。一次性面对几百行 AI 生成代码会超出认知负荷。CodeMap 的目标是把代码的"结构 + 意图 + 风险"以图谱形式呈现，并推荐阅读顺序，让 reviewer 按节点而非按行去理解。

### 1.2 核心原则（v2 新增）

> **"图必须准" 与 "能用" 同级**。任何让用户怀疑图的可信度的功能，宁可不做，也不要做错。

具体含义：
- 节点行号必须经 LSP 校准，跳源码不能跳错位
- 调用边必须可验证；不能验证的标记为 `partial`，让用户一眼看出
- 完全无法校准的节点降级为"虚节点"（灰色、不可跳转），不混在确定节点里
- prompt 设计目标是"宁可少列，不要瞎编"

### 1.3 MVP v1.0 范围（必做）
- ✅ VS Code 命令：`CodeMap: Analyze Current File`
- ✅ 仅支持 **TypeScript / JavaScript**（含 `.ts` `.tsx` `.js` `.jsx`）
- ✅ 调用 GitHub Copilot 模型（通过 `vscode.lm` API，免费）
- ✅ LLM 输出结构化 metadata（节点 + 边 + 意图 + 风险 + 置信度）
- ✅ **LSP 校准层**：所有节点/边必须通过 `executeDocumentSymbolProvider` 校验
- ✅ 节点 `verification` 状态可视化（verified / partial / unverified）
- ✅ 在 WebView 中用 Cytoscape.js 渲染交互图
- ✅ 自动计算并显示阅读顺序（1/2/3…）
- ✅ 点击节点 → fallback 链跳源码 + 高亮对应行
- ✅ 节点详情卡（意图、置信度、风险标签、校准状态）
- ✅ "标记已读"功能 + 进度条
- ✅ 流式渲染（边生成边出现节点）—— W2 提前实现
- ✅ 支持暗色/亮色主题
- ✅ **Golden test 自动度量**（precision / recall）

### 1.4 不在 MVP 范围（留给 v2+）
- ❌ Python 支持（推到 v1.1，原因：LSP 表现差异）
- ❌ 多文件 / 全仓库分析
- ❌ tree-sitter AST 验证（MVP 用 VS Code 内置 LSP 已经够用）
- ❌ 与 Copilot Chat 深度集成（如 Chat Participant）
- ❌ GitHub PR / Web SaaS 形态
- ❌ 团队协作功能（分享、评论）

---

## 二、技术架构

```
┌──────────────────────────────────────────────────────────────┐
│                  VS Code Extension Host                       │
│                                                                │
│  ┌────────────────┐  ┌────────────────────────────────────┐  │
│  │ extension.ts   │  │ WebView (Cytoscape.js + React)     │  │
│  │  - 命令注册    │←→│  - 图渲染 (含 verification 状态)   │  │
│  │  - WebView 管理│  │  - 节点交互                         │  │
│  │  - 编辑器联动  │  │  - 进度条                           │  │
│  └────────┬───────┘  └────────────────────────────────────┘  │
│           │                                                    │
│           ▼                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Calibration Layer (v2 新增)                            │  │
│  │  - 用 executeDocumentSymbolProvider 校准 range          │  │
│  │  - 用 executeDefinitionProvider 校验 calls 边           │  │
│  │  - 给每个节点/边打 verification 标记                    │  │
│  └────────┬───────────────────────────────────────────────┘  │
│           │                                                    │
│           ▼                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  vscode.lm  +  VS Code LSP (内置)                       │  │
│  └────────────────────┬───────────────────────────────────┘  │
└───────────────────────┼──────────────────────────────────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │ GitHub Copilot Chat   │ ← LM Provider
            └────────────┬───────────┘
                         │
                         ▼
            ┌───────────────────────┐
            │  GPT-4o / Claude /    │
            │  o1 (用户已订阅)      │
            └───────────────────────┘
```

### 2.1 数据流（v2 新增）

```
LLM stream
    │
    ▼
stream-parser  ── 提取 codemap-meta 块
    │
    ▼
calibrator     ── ⚙ LSP 校验，打 verification 标记
    │
    ├─ verified   → 进图
    ├─ partial    → 进图，UI 虚线
    └─ unverified → 进图，UI 灰色、不可跳转
    │
    ▼
graph-engine   ── 增量构图、去重
    │
    ▼
WebView        ── 渲染
```

### 2.2 关键设计决策
- **准确性优先**：所有 LLM 输出经过 LSP 校准才能进图（v2 核心）
- **零外部依赖**：不用 OpenAI API key，全部走 `vscode.lm`，用户用自己的 Copilot 订阅
- **流式优先**：从一开始就支持流式 metadata 解析，节点边生成边出现
- **前后端分离**：扩展主进程负责 LLM + 校准 + 编辑器，WebView 只管渲染
- **类型共享**：通过 `src/shared/types.ts` 在主进程和 WebView 共享类型
- **校准不阻塞流式**：每个节点到达即校准即渲染，校准异步进行

---

## 三、技术选型

| 模块 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript 5.x | 类型安全、VS Code 官方推荐 |
| 扩展脚手架 | `yo code` | 官方生成器 |
| 打包 | esbuild | 速度快、配置简单 |
| LLM | `vscode.lm` API（Copilot 后端） | 免费、官方、流式原生支持 |
| **LSP 校准** | **VS Code 内置 `executeDocumentSymbolProvider` / `executeDefinitionProvider`** | **零依赖、跟着用户的 TS Language Server 走** |
| 图渲染 | Cytoscape.js + cytoscape-dagre | 性能好、可交互、自动布局 |
| WebView UI | React 18 + TypeScript | 生态成熟、状态管理简单 |
| 样式 | CSS Variables + VS Code 主题 token | 自动适配暗色/亮色 |
| 状态持久化 | `vscode.Memento` (workspaceState) | 内置、无依赖 |
| 测试 | Vitest + `@vscode/test-electron` | 单元 + 集成 |
| **Golden 度量** | **自写 `eval/score.ts`** | **简单 JSON diff + precision/recall 算分** |
| Lint | ESLint + Prettier | 标准配置 |

---

## 四、数据模型（核心契约）

### 4.1 LLM 输出的结构化副产物

让 AI 在每个代码块前后输出一段 JSON，用特殊分隔符包裹便于流式提取：

````markdown
```codemap-meta
{
  "node_id": "auth.UserService.login",
  "kind": "method",
  "file": "src/auth/user_service.ts",
  "range": { "startLine": 42, "endLine": 58 },
  "intent": "校验用户名密码，返回 JWT token",
  "calls": ["auth.PasswordHasher.verify", "auth.TokenIssuer.issue"],
  "external_calls": ["bcrypt.compare", "jsonwebtoken.sign"],
  "called_by": ["api.AuthController.postLogin"],
  "confidence": 0.85,
  "risks": [
    {"type": "external_io", "desc": "查询数据库"},
    {"type": "security", "desc": "需防止时序攻击"}
  ],
  "layer": "service",
  "reading_priority": 2
}
```
````

> **v2 关键变化**：`external_calls` 字段。LLM 必须把跨文件/跨模块的调用放进 `external_calls`，而不是 `calls`。校准器只对 `calls` 做硬校验，对 `external_calls` 做软校验（用 `executeDefinitionProvider`，失败不淘汰但标 `partial`）。

最终输出一段总结：

````markdown
```codemap-summary
{
  "root_intent": "实现用户登录认证",
  "suggested_entry_nodes": ["api.AuthController.postLogin"],
  "narrative": "建议先读 AuthController 看入口，再看 UserService 的 login 主流程..."
}
```
````

### 4.2 TypeScript 类型定义

```typescript
// src/shared/types.ts
export type NodeKind = "class" | "method" | "function" | "module";

export type RiskType =
  | "external_io"
  | "security"
  | "concurrency"
  | "high_coupling"
  | "low_confidence"
  | "missing_test";

// v2 新增：校准状态
export type VerificationState =
  | "verified"    // 符号 + 行号都对得上
  | "partial"     // 符号对得上，但 calls 边有部分丢失/未确认
  | "unverified"; // 行号校准失败（虚节点，不可跳转）

export interface CodeNode {
  id: string;
  kind: NodeKind;
  file: string;
  range: { startLine: number; endLine: number };
  intent: string;
  layer?: "entry" | "controller" | "service" | "repo" | "util";
  confidence: number;            // LLM 自报
  risks: { type: RiskType; desc: string }[];
  readingPriority?: number;
  readState: "unread" | "reading" | "read";

  // v2 新增
  verification: VerificationState;
  verificationDetails?: {
    rangeAdjusted: boolean;            // 校准时行号是否被改写
    droppedCalls: string[];            // 校准时被丢弃的 calls 目标
    droppedExternalCalls: string[];    // 校准失败的 external_calls
  };
}

export interface CodeEdge {
  from: string;
  to: string;
  kind: "calls" | "external_calls" | "inherits" | "uses_type";
  // v2 新增
  verified: boolean;
}

export interface CodeMapGraph {
  nodes: Record<string, CodeNode>;
  edges: CodeEdge[];
  rootIntent?: string;
  narrative?: string;
  suggestedEntryNodes?: string[];
  readingOrder?: string[];
}

// 扩展 ↔ WebView 消息协议
export type ServerEvent =
  | { type: "node_added"; node: CodeNode }
  | { type: "edge_added"; edge: CodeEdge }
  | { type: "node_updated"; id: string; patch: Partial<CodeNode> }
  | { type: "summary"; rootIntent: string; narrative: string; entries: string[] }
  | { type: "reading_order"; order: string[] }
  // v2 新增
  | { type: "partial_failure"; reason: string; details: { node?: string; raw?: string } }
  | { type: "done"; stats: { nodeCount: number; edgeCount: number; verifiedCount: number } }
  | { type: "error"; message: string };

export type ClientEvent =
  | { type: "ready" }
  | { type: "mark_read"; nodeId: string }
  | { type: "jump_to_source"; nodeId: string }
  | { type: "reset_progress" };
```

---

## 五、目录结构

```
codemap-vscode/
├── package.json
├── tsconfig.json
├── tsconfig.webview.json
├── esbuild.js
├── .vscode/
│   ├── launch.json
│   ├── tasks.json
│   └── settings.json
├── .gitignore
├── .eslintrc.json
├── .prettierrc
├── README.md
├── CHANGELOG.md
├── LICENSE
├── DEVELOPMENT_PLAN.md
├── src/
│   ├── extension.ts
│   ├── shared/
│   │   └── types.ts
│   ├── llm/
│   │   ├── client.ts                  # vscode.lm 调用封装
│   │   ├── prompts.ts                 # CodeMap 系统 prompt（v2 含 external_calls 约束）
│   │   └── stream-parser.ts
│   ├── calibration/                   # ⭐ v2 新增
│   │   ├── calibrator.ts              # 主入口
│   │   ├── symbol-index.ts            # 缓存 DocumentSymbol 树
│   │   └── definition-resolver.ts     # 调用边解析
│   ├── graph/
│   │   ├── engine.ts
│   │   └── path-planner.ts
│   ├── webview/
│   │   ├── panel.ts
│   │   └── ui/
│   │       ├── index.tsx
│   │       ├── App.tsx
│   │       ├── GraphView.tsx
│   │       ├── NodeCard.tsx           # v2 含 verification 区块
│   │       ├── ProgressBar.tsx
│   │       ├── styles.css
│   │       └── vscode-api.ts
│   └── editor/
│       └── jump-to-source.ts          # v2 含 fallback 链
├── media/
│   └── icons/
├── examples/
│   ├── sample-output.json
│   └── sample-code/
│       ├── auth.ts
│       └── todo.ts
├── eval/                              # ⭐ v2 新增
│   ├── samples/
│   │   ├── auth.ts
│   │   ├── express-server.ts
│   │   └── todo-store.ts
│   ├── golden/
│   │   ├── auth.expected.json
│   │   ├── express-server.expected.json
│   │   └── todo-store.expected.json
│   ├── score.ts                       # 计算 precision/recall
│   └── README.md                      # 标注规范、跑分流程
├── test/
│   ├── unit/
│   │   ├── stream-parser.test.ts
│   │   ├── path-planner.test.ts
│   │   ├── graph-engine.test.ts
│   │   └── calibrator.test.ts         # v2 新增
│   └── integration/
│       └── extension.test.ts
└── docs/
    ├── architecture.md
    ├── prompt-design.md
    ├── calibration.md                 # v2 新增
    └── screenshots/
```

---

## 六、详细开发计划（4 周）

### 🟢 Phase 0：环境准备（0.5 天）

| # | 任务 | 验收标准 |
|---|---|---|
| 0.1 | 创建 GitHub 仓库 `codemap-vscode` | 仓库已建好 |
| 0.2 | 本地装好 Node.js 18+ / pnpm / VS Code | `node -v` 正常输出 |
| 0.3 | 安装 VS Code 扩展开发依赖 | `npm i -g yo generator-code @vscode/vsce` |
| 0.4 | `yo code` 生成 TypeScript 骨架 | 项目初始化完成 |
| 0.5 | F5 能进入扩展调试窗口 | 看到 "Extension Host" 窗口打开 |
| 0.6 | 确认本机 VS Code 已装 GitHub Copilot 并登录 | Copilot 状态栏正常 |

---

### 🟢 Week 1：项目骨架 + 假数据看到图（MVP α）

**目标**：用一份手写假数据，在 VS Code 侧边栏看到一张可交互的图。先不接 LLM，把整个 UI 链路打通。

| # | 任务 | 产出 | 工时 |
|---|---|---|---|
| 1.1 | 整理 `yo code` 生成的骨架 | 干净的 `extension.ts` | 0.5h |
| 1.2 | 配置 esbuild 双产物：扩展 + WebView UI | `esbuild.js` 一次构建两份 | 2h |
| 1.3 | 定义 `src/shared/types.ts` 全部类型（含 v2 的 `verification` / `external_calls`） | 类型导出可用 | 1h |
| 1.4 | 写 `examples/sample-output.json`（8~12 节点，含各种 verification 状态） | 包含 verified/partial/unverified 各 1+ 个 | 1h |
| 1.5 | 注册命令 `CodeMap: Show Demo Graph` | 命令面板能看到 | 0.5h |
| 1.6 | 创建 WebView Panel 容器 | 点击命令能弹出空白 WebView | 1.5h |
| 1.7 | WebView 内引入 React + Cytoscape.js + dagre | 渲染出假数据的图 | 3h |
| 1.8 | 节点样式：按 kind 区分形状/颜色 | 类=矩形、方法=圆角、函数=椭圆 | 1.5h |
| 1.9 | 节点上显示阅读顺序编号 | 节点左上角有数字徽标 | 1h |
| 1.10 | 风险标签：节点边框颜色按风险类型 | security=红、io=橙、低置信=黄 | 1h |
| 1.11 | **节点 verification 状态可视化** | verified=实线，partial=虚线，unverified=灰色 | 1.5h |
| 1.12 | README 草稿 + 截图 | 仓库首页能看 | 1h |

🎯 **Week 1 验收**：
- `Show Demo Graph` → 弹出 WebView → 完整图
- 图中节点有编号、有颜色区分、有风险标记、**有 verification 三态视觉差异**
- 不报错、性能正常

---

### 🟡 Week 2：节点交互 + 阅读路径 + 流式 + Golden 基建（MVP β）

**目标**：让图"活起来" + **把准确性度量基础设施先建好**。

| # | 任务 | 产出 | 工时 |
|---|---|---|---|
| 2.1 | 实现阅读路径算法 `path-planner.ts` | 入度 0 节点优先 + DFS + 风险高优先 | 2h |
| 2.2 | 单元测试 `path-planner.test.ts` | 至少 3 个用例通过 | 1h |
| 2.3 | 节点点击事件 → postMessage 给扩展 | WebView↔扩展通信打通 | 1h |
| 2.4 | **跳源码 fallback 链** `editor/jump-to-source.ts` | 4 级 fallback（见 §7.6） | 2h |
| 2.5 | 高亮跳转后的行（装饰器） | 黄色背景 + 边框，3 秒淡出 | 1h |
| 2.6 | 节点详情卡组件 `NodeCard.tsx` | 展示意图、置信度、风险标签 | 2h |
| 2.7 | **NodeCard 中展示 verification 详情**（droppedCalls、rangeAdjusted） | 让用户看到校准做了什么 | 1h |
| 2.8 | 点击节点显示卡片（侧边滑出） | UI 平滑过渡 | 1.5h |
| 2.9 | "标记已读"按钮 + 节点变灰逻辑 | 已读节点透明度 50% | 1h |
| 2.10 | 顶部进度条 `ProgressBar.tsx` | 显示 `3/12 nodes read · 10/12 verified` | 1h |
| 2.11 | 持久化已读状态到 workspaceState | 重启 VS Code 后状态保留 | 1.5h |
| 2.12 | **持久化图本身**（以文件 hash 为 key） | 重开 WebView 不用重跑 LLM | 1.5h |
| 2.13 | 命令 `CodeMap: Reset Reading Progress` | 一键清空已读 | 0.5h |
| 2.14 | 图引擎 `graph/engine.ts`：支持增量添加/合并/去重 | 为 W3 流式做准备 | 2h |
| 2.15 | WebView 改为流式接收 ServerEvent | 边收边渲染（用假数据 setTimeout 模拟） | 2h |
| 2.16 | 暗色/亮色主题适配 | 用 VS Code CSS variables | 1.5h |
| **2.17** | **⭐ 建立 `eval/` 目录 + 3 个手挑 TS 样本** | auth.ts / express-server.ts / todo-store.ts | 1.5h |
| **2.18** | **⭐ 手工标注 3 份 `*.expected.json`** | 节点 + 边 + verification 期望值 | 3h |
| **2.19** | **⭐ 写 `eval/score.ts`：JSON diff + precision/recall** | 输入：实际 graph + golden；输出：分数 | 2h |
| **2.20** | **⭐ 用假 LLM 输出跑通 `score.ts` 一次** | 输出 baseline 分数，为 W3 调优做准备 | 0.5h |

🎯 **Week 2 验收**：
- demo 图能完整体验"按顺序读 → 点节点跳源码 → 看意图卡片 → 标已读 → 进度更新"
- 假数据可"流式"喂入，节点边一个个出现
- 切换主题图样式跟随
- **`pnpm eval` 能跑出 precision/recall 数字**（哪怕用假 LLM 输出）

---

### 🟠 Week 3：接入 Copilot LLM + 校准层（MVP v1）

**目标**：真正分析一个 TS 文件，**且全程经过校准层，零幻觉跳转**。

| # | 任务 | 产出 | 工时 |
|---|---|---|---|
| 3.1 | 设计 CodeMap 系统 prompt（v2 含 `external_calls` 硬约束） | `src/llm/prompts.ts` | 2h |
| 3.2 | `vscode.lm` 封装 `src/llm/client.ts` | 模型选择 + 流式调用 | 1h |
| 3.3 | 流式 metadata 提取 `src/llm/stream-parser.ts` | 提取 `codemap-meta` 块 | 2h |
| 3.4 | 单元测试 `stream-parser.test.ts` | JSON 跨 chunk、格式错误、嵌套 | 1.5h |
| **3.5** | **⭐ 实现 `calibration/symbol-index.ts`** | 缓存当前文件 DocumentSymbol 树 | 2h |
| **3.6** | **⭐ 实现 `calibration/calibrator.ts`** | 校准 range + 校验 calls + 打 verification（见 §7.4） | 3h |
| **3.7** | **⭐ 实现 `calibration/definition-resolver.ts`** | 用 executeDefinitionProvider 软校验 external_calls | 2h |
| **3.8** | **⭐ 单元测试 `calibrator.test.ts`** | 覆盖：行号偏移、符号不存在、calls 目标不存在 | 2h |
| 3.9 | 命令 `CodeMap: Analyze Current File`（接通 LLM → calibrator → engine） | 端到端打通 | 2h |
| 3.10 | 容错：模型不可用、用户拒绝同意、配额耗尽 | 友好 toast + 文档指引 | 1.5h |
| 3.11 | Loading + 取消按钮 | UX 不掉线 | 1h |
| 3.12 | `partial_failure` 事件渲染 | UI 显示"X 个节点解析失败" | 1h |
| 3.13 | VS Code 配置：模型偏好（GPT-4o / Claude / o1） | settings.json 可配置 | 1h |
| **3.14** | **⭐ 用 3 个 eval 样本跑真实 LLM** | 拿到 baseline precision/recall | 2h |
| **3.15** | **⭐ Prompt 迭代（用 score 度量，至少 3 轮）** | 目标：节点 P/R > 0.85，边 P/R > 0.75 | 4h |
| 3.16 | 处理 `codemap-summary` 块（root_intent + narrative） | 显示导读和入口建议 | 1h |
| 3.17 | API 调用日志（output channel） | 方便 debug | 0.5h |

🎯 **Week 3 验收**：
- 任意 200~500 行 TS 文件上执行 `Analyze Current File`
- 30 秒内出现合理的调用图谱
- **节点 precision/recall ≥ 0.85，边 precision/recall ≥ 0.75**（按 eval 度量）
- **没有 unverified 节点被允许跳源码**（手测 10 次跳转都对位）
- 不需要任何 API key 配置

---

### 🟣 Week 4：打磨 + 内测（v1.0 发布）

**目标**：从"能用"到"想给别人看"。

| # | 任务 | 产出 | 工时 |
|---|---|---|---|
| 4.1 | UI 视觉打磨（配色、字体、间距） | 截图发出去不丢人 | 3h |
| 4.2 | 完善暗色/亮色主题适配 | 全场景测试 | 1.5h |
| 4.3 | **verification 状态在 UI 上的最终打磨**（图例、tooltip、文案） | 用户能看懂三态含义 | 2h |
| 4.4 | 错误边界 + 友好错误提示 | 不让用户看到红色堆栈 | 1.5h |
| 4.5 | 写完整 README（含截图/GIF/快速开始 + 准确性说明） | 仓库首页好看 | 2h |
| 4.6 | 录一个 1~2 分钟 demo GIF | LICEcap 或 Kap | 1h |
| 4.7 | 写 `docs/calibration.md` | 解释校准做了什么、为什么 | 1h |
| 4.8 | 写 CHANGELOG.md | v0.1.0 起 | 0.5h |
| 4.9 | `extensionDependencies` 自动装 Copilot Chat | package.json | 0.5h |
| 4.10 | 写 `docs/prompt-design.md` | 给后来贡献者看 | 1h |
| 4.11 | 集成测试：扩展激活、命令执行、消息往返 | `test/integration/` | 2h |
| 4.12 | 打包 `.vsix` | `vsce package` | 0.5h |
| 4.13 | 内部分享给 3~5 个同事试用 | 收集反馈 | - |
| 4.14 | 修 P0 bug（至少 1 轮迭代） | issue 关闭 | 2~4h |
| 4.15 | （可选）发布到 VS Code Marketplace | publisher.token + `vsce publish` | 1h |

🎯 **Week 4 验收**：
- 同事拿到 `.vsix` 装上后能跑通
- README 截图/GIF 清晰，**包含"我们是怎么保证图准确的"章节**
- 至少 1 位同事反馈"有用"
- 内测中跳源码错位率 = 0

---

## 七、关键代码示例

### 7.1 `vscode.lm` 调用 Copilot 模型

```typescript
// src/llm/client.ts
import * as vscode from 'vscode';

export async function* streamAnalyze(
  systemPrompt: string,
  userCode: string,
  filePath: string,
  preferredFamily: string,
  token: vscode.CancellationToken
): AsyncGenerator<string, void, void> {
  const models = await vscode.lm.selectChatModels({
    vendor: 'copilot',
    family: preferredFamily,
  });
  if (models.length === 0) {
    throw new Error(
      `No Copilot model available for family "${preferredFamily}". ` +
      `Please ensure GitHub Copilot is installed and signed in.`
    );
  }
  const model = models[0];

  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    vscode.LanguageModelChatMessage.User(
      `File: ${filePath}\n\n\`\`\`\n${userCode}\n\`\`\``
    ),
  ];

  const response = await model.sendRequest(messages, {}, token);
  for await (const fragment of response.text) {
    if (token.isCancellationRequested) return;
    yield fragment;
  }
}
```

### 7.2 流式 `codemap-meta` 块提取

```typescript
// src/llm/stream-parser.ts
import { CodeNode } from '../shared/types';

const OPEN = '```codemap-meta';
const CLOSE = '```';

// LLM 给的"原始" CodeNode（没有 verification 字段）
export type RawCodeNode = Omit<CodeNode, 'verification' | 'verificationDetails' | 'readState'> & {
  external_calls?: string[];
  called_by?: string[];
};

export class CodeMapMetaExtractor {
  private buffer = '';

  feed(chunk: string): RawCodeNode[] {
    this.buffer += chunk;
    const out: RawCodeNode[] = [];
    while (true) {
      const start = this.buffer.indexOf(OPEN);
      if (start < 0) break;
      const end = this.buffer.indexOf(CLOSE, start + OPEN.length);
      if (end < 0) break;
      const json = this.buffer.slice(start + OPEN.length, end).trim();
      try {
        out.push(JSON.parse(json) as RawCodeNode);
      } catch (e) {
        console.warn('Malformed codemap-meta block, skipping', e);
      }
      this.buffer = this.buffer.slice(end + CLOSE.length);
    }
    return out;
  }

  flush(): void {
    this.buffer = '';
  }
}
```

### 7.3 阅读路径算法（不变）

```typescript
// src/graph/path-planner.ts
import { CodeMapGraph } from '../shared/types';

export function computeReadingPath(graph: CodeMapGraph): string[] {
  const inDegree = new Map<string, number>();
  for (const id of Object.keys(graph.nodes)) inDegree.set(id, 0);
  for (const e of graph.edges) {
    if (e.kind === 'calls') {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }

  const nodes = Object.values(graph.nodes);
  const entries = nodes
    .filter(n => (inDegree.get(n.id) ?? 0) === 0 || n.layer === 'entry')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map(n => n.id);

  const order: string[] = [];
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    order.push(id);
    const children = graph.edges
      .filter(e => e.from === id && e.kind === 'calls')
      .map(e => graph.nodes[e.to])
      .filter(Boolean)
      .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1));
    for (const c of children) visit(c.id);
  };

  for (const id of entries) visit(id);
  for (const id of Object.keys(graph.nodes)) if (!visited.has(id)) visit(id);
  return order;
}
```

### 7.4 ⭐ 校准器（v2 新增）

```typescript
// src/calibration/calibrator.ts
import * as vscode from 'vscode';
import { CodeNode, CodeEdge, VerificationState } from '../shared/types';
import { RawCodeNode } from '../llm/stream-parser';
import { SymbolIndex } from './symbol-index';

export interface CalibrationResult {
  node: CodeNode;
  edges: CodeEdge[];
}

export class Calibrator {
  constructor(
    private symbolIndex: SymbolIndex,
    private docUri: vscode.Uri,
  ) {}

  async calibrate(raw: RawCodeNode): Promise<CalibrationResult | null> {
    // 1. 在 DocumentSymbol 树里找匹配 node_id 的符号
    const lastSegment = raw.node_id.split('.').pop()!;
    const symbol = await this.symbolIndex.findByName(lastSegment, raw.kind);

    let verification: VerificationState = 'verified';
    let range = raw.range;
    let rangeAdjusted = false;
    const droppedCalls: string[] = [];
    const droppedExternal: string[] = [];

    if (!symbol) {
      // 整个符号都找不到 → 虚节点
      verification = 'unverified';
    } else {
      // 用 LSP 拿到的真实 range 覆盖 LLM 给的（最关键的一步）
      const sym = symbol.range;
      if (sym.start.line + 1 !== raw.range.startLine ||
          sym.end.line + 1 !== raw.range.endLine) {
        rangeAdjusted = true;
      }
      range = {
        startLine: sym.start.line + 1,
        endLine: sym.end.line + 1,
      };
    }

    // 2. 校验 calls：必须在本文件 DocumentSymbol 里能找到
    const verifiedCalls: string[] = [];
    for (const target of raw.calls ?? []) {
      const targetSym = await this.symbolIndex.findByName(
        target.split('.').pop()!,
      );
      if (targetSym) {
        verifiedCalls.push(target);
      } else {
        droppedCalls.push(target);
      }
    }
    if (droppedCalls.length > 0 && verification === 'verified') {
      verification = 'partial';
    }

    // 3. 软校验 external_calls：找不到不淘汰，但标 partial
    const verifiedExternal: string[] = [];
    for (const target of raw.external_calls ?? []) {
      try {
        const defs = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
          this.docUri,
          new vscode.Position(range.startLine - 1, 0),
        );
        if (defs && defs.length > 0) {
          verifiedExternal.push(target);
        } else {
          droppedExternal.push(target);
        }
      } catch {
        droppedExternal.push(target);
      }
    }
    if (droppedExternal.length > 0 && verification === 'verified') {
      verification = 'partial';
    }

    const node: CodeNode = {
      id: raw.node_id,
      kind: raw.kind,
      file: raw.file,
      range,
      intent: raw.intent,
      layer: raw.layer,
      confidence: raw.confidence,
      risks: raw.risks ?? [],
      readingPriority: raw.reading_priority,
      readState: 'unread',
      verification,
      verificationDetails: {
        rangeAdjusted,
        droppedCalls,
        droppedExternalCalls: droppedExternal,
      },
    };

    const edges: CodeEdge[] = [
      ...verifiedCalls.map<CodeEdge>(to => ({
        from: raw.node_id, to, kind: 'calls', verified: true,
      })),
      ...verifiedExternal.map<CodeEdge>(to => ({
        from: raw.node_id, to, kind: 'external_calls', verified: true,
      })),
    ];

    return { node, edges };
  }
}
```

```typescript
// src/calibration/symbol-index.ts
import * as vscode from 'vscode';

export class SymbolIndex {
  private symbols: vscode.DocumentSymbol[] = [];
  private flatSymbols = new Map<string, vscode.DocumentSymbol>();

  constructor(private docUri: vscode.Uri) {}

  async load(): Promise<void> {
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      this.docUri,
    );
    this.symbols = result ?? [];
    this.flatten(this.symbols);
  }

  private flatten(syms: vscode.DocumentSymbol[]): void {
    for (const s of syms) {
      this.flatSymbols.set(s.name, s);
      if (s.children) this.flatten(s.children);
    }
  }

  async findByName(
    name: string,
    kind?: string,
  ): Promise<vscode.DocumentSymbol | undefined> {
    return this.flatSymbols.get(name);
  }
}
```

### 7.5 系统 Prompt 模板（v2 强化版）

````typescript
// src/llm/prompts.ts
export const CODEMAP_SYSTEM_PROMPT = `
你是 CodeMap 的代码分析助手。你的任务是分析用户提供的 TypeScript/JavaScript 源代码文件，
为每一个**类、方法、重要函数**输出一段结构化的 metadata，并在最后输出一段总体导读。

## 强制输出格式

对每个代码单元，按下面格式输出一个 metadata 块：

\`\`\`codemap-meta
{
  "node_id": "<符号名>",
  "kind": "class" | "method" | "function" | "module",
  "file": "<相对路径>",
  "range": { "startLine": <int>, "endLine": <int> },
  "intent": "<不超过 30 字的目的描述>",
  "calls": ["<本文件内的符号名>", ...],
  "external_calls": ["<跨文件的符号名>", ...],
  "called_by": ["<本文件内的符号名>", ...],
  "confidence": <0.0-1.0>,
  "risks": [
    {"type": "external_io|security|concurrency|high_coupling|low_confidence|missing_test",
     "desc": "<10-20 字风险说明>"}
  ],
  "layer": "entry" | "controller" | "service" | "repo" | "util",
  "reading_priority": <1=最先读, 5=最后读>
}
\`\`\`

## ⚠ 硬约束（违反则节点会被丢弃）

### 关于 calls 字段
1. **必须**是你在用户提供的源代码中**亲眼看到**的符号
2. 必须是本文件内定义的符号（不能是 import 进来的）
3. 不确定时 → 不要列出，放进 risks (type: low_confidence)
4. 不要瞎编符号名；不要把 \`array.map\` / \`promise.then\` 这种语言内置当成 call

### 关于 external_calls 字段
1. 跨文件、跨模块、来自 import 的调用放这里
2. 用源代码中实际的标识符；不要猜外部 API 名字

### 关于 range
1. \`startLine\` 是符号定义所在的**第一行**（包括签名/decorator）
2. \`endLine\` 是符号定义的**最后一行**（含闭合 \`}\`）
3. 行号从 1 开始

### 关于 node_id
1. 使用符号在源码中出现的精确名字（区分大小写）
2. 对方法用 "ClassName.methodName" 格式
3. 对顶层函数直接用函数名

## 自评原则
- confidence < 0.7 → 必须列出 low_confidence 风险
- 涉及 I/O、外部服务调用 → 列出 external_io 风险
- 涉及密码、token、加密 → 列出 security 风险
- 入口/主流程 → reading_priority: 1，纯工具函数 → reading_priority: 5

## 最后输出导读

\`\`\`codemap-summary
{
  "root_intent": "<整个文件的核心目标>",
  "suggested_entry_nodes": ["<node_id>", ...],
  "narrative": "<3-5 句话的导读>"
}
\`\`\`

## 注意
- 只输出 metadata 块和 summary 块，不要输出额外说明文字
- 宁可少列也不要瞎编；CodeMap 会用 TypeScript 语言服务器校验你的输出，
  瞎编的 calls 会被静默丢弃，太多丢弃会让整个节点被标记为不可信
`;
````

### 7.6 ⭐ 跳源码 fallback 链（v2 新增）

```typescript
// src/editor/jump-to-source.ts
import * as vscode from 'vscode';
import { CodeNode } from '../shared/types';

export async function jumpToSource(node: CodeNode): Promise<boolean> {
  if (node.verification === 'unverified') {
    vscode.window.showWarningMessage(
      `Cannot jump to "${node.id}": location not verified. Use Find Symbol manually.`,
    );
    return false;
  }

  const uri = vscode.Uri.file(node.file);
  const doc = await vscode.workspace.openTextDocument(uri);

  // Level 1: 用 LLM 给的（已被 calibrator 改写过的）range
  const range1 = new vscode.Range(
    node.range.startLine - 1, 0,
    node.range.endLine - 1, 0,
  );
  if (await verifyRangeHasSymbol(doc, range1, node.id)) {
    return await reveal(doc, range1);
  }

  // Level 2: 重新查 DocumentSymbol
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider', uri,
  );
  const found = findSymbolDeep(symbols ?? [], node.id.split('.').pop()!);
  if (found) {
    return await reveal(doc, found.range);
  }

  // Level 3: workspace symbol search
  const workspaceSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider', node.id.split('.').pop()!,
  );
  const wsHit = workspaceSymbols?.find(s => s.location.uri.toString() === uri.toString());
  if (wsHit) {
    return await reveal(doc, wsHit.location.range);
  }

  // Level 4: 友好失败（不静默打开错位置）
  vscode.window.showWarningMessage(
    `Cannot locate "${node.id}" in source. The graph may be out of sync with the file.`,
  );
  return false;
}

async function reveal(doc: vscode.TextDocument, range: vscode.Range): Promise<boolean> {
  const editor = await vscode.window.showTextDocument(doc, { selection: range });
  // 装饰器高亮 3 秒
  const decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: true,
  });
  editor.setDecorations(decoration, [range]);
  setTimeout(() => decoration.dispose(), 3000);
  return true;
}

async function verifyRangeHasSymbol(
  doc: vscode.TextDocument, range: vscode.Range, symbolId: string,
): Promise<boolean> {
  const text = doc.getText(range);
  const lastSegment = symbolId.split('.').pop()!;
  return text.includes(lastSegment);
}

function findSymbolDeep(
  symbols: vscode.DocumentSymbol[], name: string,
): vscode.DocumentSymbol | undefined {
  for (const s of symbols) {
    if (s.name === name) return s;
    if (s.children) {
      const found = findSymbolDeep(s.children, name);
      if (found) return found;
    }
  }
  return undefined;
}
```

### 7.7 ⭐ Golden 测试度量（v2 新增）

```typescript
// eval/score.ts
import * as fs from 'fs';
import * as path from 'path';
import { CodeMapGraph } from '../src/shared/types';

interface Score {
  nodes: { precision: number; recall: number; f1: number };
  edges: { precision: number; recall: number; f1: number };
}

export function scoreGraph(actual: CodeMapGraph, golden: CodeMapGraph): Score {
  const actualNodes = new Set(Object.keys(actual.nodes));
  const goldenNodes = new Set(Object.keys(golden.nodes));
  const nodeIntersect = [...actualNodes].filter(x => goldenNodes.has(x));

  const nodeP = nodeIntersect.length / Math.max(actualNodes.size, 1);
  const nodeR = nodeIntersect.length / Math.max(goldenNodes.size, 1);
  const nodeF1 = 2 * nodeP * nodeR / Math.max(nodeP + nodeR, 1e-9);

  const edgeKey = (e: { from: string; to: string }) => `${e.from}→${e.to}`;
  const actualEdges = new Set(actual.edges.map(edgeKey));
  const goldenEdges = new Set(golden.edges.map(edgeKey));
  const edgeIntersect = [...actualEdges].filter(x => goldenEdges.has(x));

  const edgeP = edgeIntersect.length / Math.max(actualEdges.size, 1);
  const edgeR = edgeIntersect.length / Math.max(goldenEdges.size, 1);
  const edgeF1 = 2 * edgeP * edgeR / Math.max(edgeP + edgeR, 1e-9);

  return {
    nodes: { precision: nodeP, recall: nodeR, f1: nodeF1 },
    edges: { precision: edgeP, recall: edgeR, f1: edgeF1 },
  };
}

if (require.main === module) {
  const samplesDir = path.join(__dirname, 'samples');
  const goldenDir = path.join(__dirname, 'golden');
  const runsDir = path.join(__dirname, 'runs');

  const samples = fs.readdirSync(samplesDir).filter(f => f.endsWith('.ts'));
  for (const sample of samples) {
    const base = path.basename(sample, '.ts');
    const golden = JSON.parse(fs.readFileSync(path.join(goldenDir, `${base}.expected.json`), 'utf8'));
    const actual = JSON.parse(fs.readFileSync(path.join(runsDir, `${base}.actual.json`), 'utf8'));
    const score = scoreGraph(actual, golden);
    console.log(`\n=== ${base} ===`);
    console.log(`Nodes: P=${score.nodes.precision.toFixed(2)} R=${score.nodes.recall.toFixed(2)} F1=${score.nodes.f1.toFixed(2)}`);
    console.log(`Edges: P=${score.edges.precision.toFixed(2)} R=${score.edges.recall.toFixed(2)} F1=${score.edges.f1.toFixed(2)}`);
  }
}
```

### 7.8 `package.json` 关键配置

```json
{
  "name": "codemap-vscode",
  "displayName": "CodeMap",
  "description": "Interactive call graph + reading guidance for AI-generated TypeScript code",
  "version": "0.1.0",
  "publisher": "your-publisher-id",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Visualization", "Other"],
  "main": "./dist/extension.js",
  "extensionDependencies": ["GitHub.copilot-chat"],
  "activationEvents": ["onCommand:codemap.analyzeCurrentFile"],
  "contributes": {
    "commands": [
      { "command": "codemap.analyzeCurrentFile", "title": "CodeMap: Analyze Current File" },
      { "command": "codemap.showDemoGraph", "title": "CodeMap: Show Demo Graph" },
      { "command": "codemap.resetReadingProgress", "title": "CodeMap: Reset Reading Progress" }
    ],
    "configuration": {
      "title": "CodeMap",
      "properties": {
        "codemap.preferredModelFamily": {
          "type": "string",
          "default": "gpt-4o",
          "enum": ["gpt-4o", "claude-3.5-sonnet", "o1"],
          "description": "Preferred LLM model family."
        },
        "codemap.strictVerification": {
          "type": "boolean",
          "default": true,
          "description": "When true, unverified nodes are shown but not clickable."
        }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.js",
    "watch": "node esbuild.js --watch",
    "package": "vsce package",
    "test": "vitest",
    "eval": "ts-node eval/score.ts"
  },
  "devDependencies": {
    "@types/vscode": "^1.90.0",
    "@types/node": "^18.0.0",
    "typescript": "^5.0.0",
    "esbuild": "^0.20.0",
    "vitest": "^1.0.0",
    "ts-node": "^10.0.0",
    "@vscode/vsce": "^2.0.0"
  },
  "dependencies": {
    "cytoscape": "^3.28.0",
    "cytoscape-dagre": "^2.5.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
```

---

## 八、测试与验收

### 8.1 单元测试
- `stream-parser.test.ts`：JSON 跨 chunk、格式错误、嵌套引号
- `path-planner.test.ts`：入度 0 优先、风险高优先、环检测、孤岛节点
- `graph-engine.test.ts`：节点去重、增量合并、边一致性
- **`calibrator.test.ts`（v2 新增）**：
  - LLM 给的行号偏移 5 行 → calibrator 改写为正确行号，verification=verified, rangeAdjusted=true
  - LLM 给的 node_id 不存在 → verification=unverified
  - LLM 给 5 个 calls，其中 2 个不存在 → 丢弃 2 个，verification=partial，droppedCalls 记录
  - external_calls 找不到定义 → 保留为 partial，不丢弃节点

### 8.2 集成测试
- 扩展激活后命令是否注册成功
- WebView 创建与消息往返
- LLM mock 输入 → 完整图渲染
- **校准链路 e2e**：mock LLM 输出 → calibrator → engine → WebView，verification 状态正确传递

### 8.3 ⭐ 准确性度量（v2 新增）

每次 prompt 调优后跑 `pnpm eval`，目标：

| 指标 | MVP 目标 | v1.1 目标 |
|---|---|---|
| 节点 precision | ≥ 0.85 | ≥ 0.95 |
| 节点 recall | ≥ 0.85 | ≥ 0.90 |
| 边 precision | ≥ 0.75 | ≥ 0.90 |
| 边 recall | ≥ 0.75 | ≥ 0.85 |
| 跳源码命中率（手测） | 100%（不允许错位） | 100% |

### 8.4 手动验收清单
- [ ] `F5` 调试模式能进入扩展开发主机
- [ ] `Show Demo Graph` 命令显示假数据图，含三态 verification
- [ ] `Analyze Current File` 对真实 TS 文件能产出合理图
- [ ] **节点 verification 三态可视化清晰**（实线/虚线/灰色）
- [ ] 节点点击跳源码 + 高亮，**绝不跳错位置**
- [ ] **unverified 节点点击不跳转，弹出友好提示**
- [ ] 详情卡显示意图/风险 + 校准详情（rangeAdjusted、droppedCalls）
- [ ] 阅读顺序编号合理
- [ ] 标记已读后节点变灰，进度条更新
- [ ] 重启 VS Code 后已读状态保留
- [ ] 切换暗色/亮色主题图样式跟随
- [ ] 无 Copilot 订阅的用户看到友好错误提示
- [ ] 取消按钮能中断 LLM 调用
- [ ] **`pnpm eval` 通过 MVP 目标分数**

### 8.5 内测指标
找 3~5 个同事，每人用 CodeMap 看 1 段 AI 生成 TS 代码，记录：
- 完整理解代码所需时间（对比纯阅读）
- 找出预埋 bug 的成功率
- **跳源码错位次数（目标 = 0）**
- **是否被 unverified 节点的灰色样式误导**
- 主观可用性评分（1~5 分）

---

## 九、风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| LLM 不按格式输出 metadata | 高 | 中 | Few-shot 示例 + 严格 JSON schema + 解析失败时跳过、不中断 |
| **LLM 给的行号错位** | **高** | **低（v2 已解决）** | **calibrator 用 LSP 改写行号** |
| **LLM 编造调用边** | **高** | **低（v2 已解决）** | **calibrator 校验 calls 必须在 DocumentSymbol 中存在** |
| Cytoscape 大图性能差（>100 节点） | 中 | 中 | MVP 限制单次分析 ≤ 50 节点；超出时分层折叠 |
| Copilot 模型不可用 / 额度耗尽 | 中 | 高 | 友好 toast + 文档指引 + 让用户切换 family |
| TS Language Server 加载慢（首次打开大项目） | 中 | 中 | calibrator 等待 + 超时降级到"全部 unverified"模式 |
| 用户拒绝 Copilot 同意弹窗 | 低 | 中 | 优雅降级到 demo 模式 + 文档说明 |
| WebView 与扩展通信延迟 | 低 | 低 | 消息批处理 + RAF 节流渲染 |
| 内测中发现 prompt 在某些代码风格下表现差 | 中 | 中 | eval 样本扩到 5~10 个，覆盖不同风格 |
| Python 用户失望 | 中 | 低 | README 明确写"v1.1 加 Python"，issue 模板有占位 |

---

## 十、后续路线图（v2+）

### v1.1（短期优化，~2 周）
- **Python 支持**：复用 calibrator 框架，对接 Pylance LSP
- prompt 调优：节点 P/R 提到 0.95
- 节点合并/聚合（按 layer 折叠）

### v1.2
- 多文件分析（按目录/PR diff 选范围）
- tree-sitter 作为 LSP 的备用校准（处理 LSP 没启动的边缘情况）
- 图导出为 PNG / SVG / Mermaid

### v2.0（架构演进）
- 把图引擎抽成独立 npm 包 `@codemap/engine`
- 把 calibrator 抽成独立包 `@codemap/calibrator`（其他工具也能用）
- 提供 JetBrains 插件（IntelliJ / WebStorm）
- 提供 CLI 用于 CI/CD

### v3.0（产品化）
- **GitHub App**：在 PR 页面嵌入图谱 + 阅读引导（最大市场机会）
- Web SaaS：仓库级架构浏览
- 团队协作：评论、分享、@提醒

---

## 十一、参考资料

### 官方文档
- [VS Code Extension API](https://code.visualstudio.com/api)
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [VS Code WebView API](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code DocumentSymbol Provider](https://code.visualstudio.com/api/references/vscode-api#DocumentSymbolProvider)
- [`executeDocumentSymbolProvider` 命令](https://code.visualstudio.com/api/references/commands)

### 示例代码
- [vscode-extension-samples](https://github.com/microsoft/vscode-extension-samples)
- [chat-sample](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-sample) ← LM API 用法
- [vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat)

### 第三方库
- [Cytoscape.js](https://js.cytoscape.org/)
- [cytoscape-dagre](https://github.com/cytoscape/cytoscape.js-dagre)

### 相关产品参考
- Sourcegraph Cody
- GitHub Copilot Workspace
- CodeRabbit
- Graphify

---

## 附录 A：每周交付物快速对照（v2）

| 周次 | 阶段 | 关键交付 | 准确性度量 | 可演示？ |
|---|---|---|---|---|
| W1 | MVP α | 假数据可视化图、节点编号、风险颜色、**三态 verification 视觉** | — | ✅ 静态图 |
| W2 | MVP β | 跳源码 fallback、详情卡、已读进度、流式 UI、**eval 基建** | baseline 分（假数据） | ✅ 完整交互 |
| W3 | MVP v1 | 接 Copilot LM、**校准层**、prompt 调优到目标分数 | **节点 P/R ≥ 0.85，边 P/R ≥ 0.75** | ✅ 端到端 |
| W4 | v1.0 | 打磨、文档、`.vsix`、内测 | **跳源码错位率 = 0** | ✅ 可分享 |

## 附录 B：每天的最小推进单位

- 🌱 **打底日**：环境/骨架/类型定义
- 🎨 **UI 日**：组件、样式、布局
- 🧠 **算法日**：路径规划、流式解析、**校准逻辑**
- 🔌 **联调日**：消息往返、命令注册
- 🧪 **测试日**：单测、**eval 跑分**、修 bug
- 📝 **文档日**：README、截图、**prompt 调优 + score 对比**

按这个节奏，每周稳定推进 4~5 个任务即可达成里程碑。

---

## 附录 C：v2 的核心心智模型

> **"图必须准" 不是一个 W4 才考虑的优化项，而是 W1 第一行代码就开始铺路的架构原则。**

具体落到三个不变量：

1. **没有未校准的节点会出现在 UI 上看似正常**
   → verification 字段从 W1 就在类型定义里，UI 从 W1 就区分三态显示

2. **没有 prompt 调优是凭感觉做的**
   → eval/ 在 W2 末尾就建好，W3 调优的每一步都有数字

3. **没有跳转会静默跳错位置**
   → jump-to-source 的 fallback 链在 W2 就实现，W4 内测时手测验证

如果哪天发现一个改动违反了这三条不变量之一，**这个改动就先停下来**，重新设计。

---

> **建议**：把这份文档作为活文档（living doc），随开发进展更新"已完成 ✅ / 进行中 🔄 / 待办 ⏳"标记。
