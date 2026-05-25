# Checkpoint — Method-as-Node Webview Redesign

> **状态**：in-flight，Slice 2 已交付，等待 HITL 反馈后进 Slice 3。
> **创建时间**：2026-05-25
> **目的**：跨机继续工作的恢复点。

## 当前定位

正在把 codemap 的 webview 从 **UML 类图（类节点 + UML 隔间）** 重做成 **方法即节点（class 作为 compound swimlane，方法是子节点）** 的调用图。用户之前的反馈："UML 类图显示还是不行。我们要改设计理念……彻底重做：推翻现有 mockup，以新思路重画起。"

## 已锁定的 6 个默认决策（不再追问）

| # | 决策 | 取值 |
|---|------|------|
| 1 | 构造函数 | 从图里 drop（仅 Details 卡片里出现） |
| 2 | 孤立方法（入度+出度=0） | 默认隐藏，过滤芯片可显 |
| 3 | `ext:` 节点 | 全图共享单节点，多入边 |
| 4 | BC 区分 | 保留颜色 + swimlane 边框 |
| 5 | swimlane 视觉 | UML 风格的 compound box + class header |
| 6 | 方法节点徽章 | 只保留 risk `●`，砍掉 read/verify 标记 |

## 锁定的切片计划

| Slice | 内容 | 模式 | 状态 |
|-------|------|------|------|
| 1 | mockup 数据层 + Cytoscape 节点/边生成切到方法级 | AFK + show result | ✅ 已交付 |
| 2 | 类 swimlane (compound parent) 视觉 + 折叠机制 | HITL | ✅ 已交付（等用户验收） |
| 3 | Focus 模式重写（方法级 BFS） | AFK | ⏳ 下一步 |
| 4 | All 模式 + 孤立方法过滤 + 大图性能验证 | HITL | ⏳ |
| 5 | 删 explode/collapseExploded/`▶` 标记 等死代码 | AFK | ⏳ |
| 6 | 同步到扩展 webview adapter，重打包 | AFK | ⏳ |

## 关键路径变更

- **文件改名**：`docs/mockups/lumen-backend-v3.html` → `docs/mockups/codemap-view.html`（去掉 `lumen-` 前缀，因为 codemap 是通用工具）
- 同步更新了：`src/webview/panel.ts`（2 处）、`.vscodeignore`、`esbuild.js`、`CONTRIBUTING.md`、`docs/plan/development-plan-v3-repo-level.md`、`CHANGELOG.md`

## Slice 1 已完成内容（在 `docs/mockups/codemap-view.html` 内）

- `CLASSES` 数据层：~16 个关键方法补上 `calls` / `externalCalls`，覆盖 Capture/Recall/Ask/host 全链路
- 5 趟节点/边构建流水线（替换原先的单层 class-edge 构建）：
  1. compound parent（每个 class 一个）
  2. method child（`__cmVisibleMethodsOf(c)`，drop 构造函数）
  3. `ext:` 节点
  4. method 级 edge（来自 `m.calls` / `m.externalCalls`）
  5. class 级 edge（fallback：用于 unverified 或缺失方法归因的边）
  6. 孤立 `ext:` 节点剪枝
- Cytoscape 样式：
  - `node.cls` compound parent（round-rect、BC 色边框、text-valign top）
  - `node.method` 小药丸（BC 染色背景）
  - `node.ext` 保留虚线青色
- Focus 模型从"explode class into method nodes"切到"方法永远挂在 compound 里，focus = 方法节点高亮 + 兄弟变暗"，新状态变量 `__cmFocusedMethodNodeId` 取代 `__cmExplodedClassId` / `__cmExplodedMethodName`
- `applyFilters` 重写：父 hide → 子 hide；fold 状态独立追踪
- `applySwimlanes` 中 BC banding 算法停用（compound 下不再有意义），保留 taxi 边路由
- Tap 事件：`node.cls` → selectClass，`node.method` → setFocus，`node.ext` → selectExternal

## Slice 2 已完成内容

- `buildClassHeader(c, folded)`：增加 fold 参数。展开 `ClassId ✓ ▾`，折叠 `ClassId ✓ ▸ N methods`
- `__cmClassLabel(c)` / `__cmApplyNodeFold(c, collapsed)`：fold 状态写回 header label，双击 class 时 chevron 翻转
- `node.cls` 样式升级：
  - 背景换成 BC 色调（capture `#16221f` / recall `#1f161f` / host `#222016` / shared `#161c24`）
  - header 加 `text-background-color` 暗色衬底，避免被子节点淹没
  - padding 18 → 20
- 折叠交互：双击 class 切换；`window.__codemapCollapse.toggleAll()` 全部折叠（无 UI 入口）

## Git 状态（关键）

- 本地分支 `main` 比 `origin/main` 领先 **6 个 commit**（之前 slice 的工作已 local commit 但未 push）
- 未提交改动（`git status --short`）：
  ```
  M  .vscodeignore
  M  CHANGELOG.md
  M  CONTRIBUTING.md
  RM docs/mockups/lumen-backend-v3.html -> docs/mockups/codemap-view.html
  M  docs/plan/development-plan-v3-repo-level.md
  M  esbuild.js
  M  src/eval/score.ts          ← 早先的 ext canonicaliser 修复
  M  src/webview/panel.ts
  M  test/unit/score.test.ts    ← score.ts 配套测试
  ```
- 最近 5 个本地 commit：
  ```
  3425322 fix(webview): lazy-mount method children so All-mode layout stays intact
  2bffd06 feat(webview): explode focused class into method-level call edges
  cf62ad9 feat(orchestrator): two-batch progressive rendering (B-2 MVP)
  2224bae feat(scan): raise maxSkeletonFiles ceiling 80->500; surface total file count
  064e790 feat(webview): outline header click focuses entry class as a whole
  ```

## 跨机恢复操作

在另一台电脑上：

1. `git pull`（如果原机器 push 了）；否则 push/pull 一次先：
   - 原机器：`git add -A; git commit -m "wip: method-as-node slices 1-2"; git push origin main`
   - 新机器：`git pull origin main`
2. 打开仓库后读这个文件（`docs/plan/checkpoint-method-as-node.md`）+ `CHANGELOG.md` Unreleased 段
3. 让 agent 进入 Slice 3（Focus 模式方法级 BFS 重写）

## Slice 3 已经做的预备（细节给下一轮 agent）

`docs/mockups/codemap-view.html` 里这些已就位（无需重写，下一步基于此推进）：
- `__buildMethodAdjacency()`：基于 `edges` 数组建方法级邻接表
- `bfsMethods(originNodeId, depth)`：方法级 BFS
- `focusSetForCurrent()`：返回包含 method 节点 + 它们的 compound parent + ext 节点的 Set
- `getDepthsFromFocus()`：把方法 depth 折叠到 class 级 min depth（给 outline 用）
- `__cmFocusedMethodNodeId`：当前 focus 的方法节点 id（`${classId}.${methodName}`）
- `applyMethodFocusHighlight()`：在 anchor 上加 `method-focus`，对同 compound 兄弟加 `dimmed`
- `applyFocusMask()`：自动隐藏所有 children 都不在 focus set 的 compound parent

Slice 3 要做的事：把上面这些拼起来，让 Focus / All 切换流程跑通；处理 depth slider 1/2/3/∞；back/forward history。

## 当前产物

- VSIX：`codemap-0.0.8.vsix`（397 KB），含 slice 1 + slice 2 的所有改动
- 浏览器可直接打开：`docs/mockups/codemap-view.html`

## 等用户验收 Slice 2 之后

在 Slice 3 开工前应再问一遍是否还有视觉 / 折叠交互的细节要调（HITL slice 的本意），否则直接进。
