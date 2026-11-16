# 巨石文件拆分记录与后续方案

> 记录 `apps/desktop/src/main/services/chat.ts` 与
> `apps/desktop/src/renderer/src/redesign/ChatFirstShell.tsx` 的拆分过程：
> 已经拆了什么、依赖规则、剩下的为什么拆不动、下一步该怎么做。
>
> 最后更新：2026-11-16

## 一、起因

两个文件在拆分前分别是：

| 文件 | 行数 | 体积 | 问题 |
|---|---|---|---|
| `main/services/chat.ts` | 4,943 | 257 KB | 类型、纯函数、`registerChatIpc`（约 3,000 行闭包）全挤在一起 |
| `renderer/redesign/ChatFirstShell.tsx` | 7,102 | 278 KB | 约 50 个组件 + 外壳状态编排，全在一个文件 |

## 二、已完成

### 2.1 主进程

| 新文件 | 行数 | 内容 | 依赖 |
|---|---|---|---|
| `main/services/chat/refusal.ts` | 151 | `MAX_REFUSAL_RETRY`、`PAL_BOOST`、`REFUSAL_BOOST`、`isSoftRefusal` 及判定辅助 | 无（纯字符串逻辑） |

`chat.ts` 4,943 → **4,803 行**。

### 2.2 渲染层

| 新文件 | 行数 | 内容 |
|---|---|---|
| `redesign/settings-pane.tsx` | 956 | 设置主壳 + 通用 / 扩展 / 关于面板 + `Segmented` / `Toggle` |
| `redesign/tasks-pane.tsx` | 857 | 任务列表、左栏任务轨道、任务详情与表单 |
| `redesign/git-widget.tsx` | 782 | Git 状态探测、分支、提交、工作区菜单 |
| `redesign/profile-pane.tsx` | 440 | 角色资料卡 `ProfileView` + 角色编辑器 `PersonaEditor` |
| `redesign/shell-bits.tsx` | 233 | `ContextMenu` / `AddMenu` / `DragBar` / `useRelativeTime` |
| `redesign/message-actions.tsx` | 185 | 复制按钮 + 回答反馈（好的 / 有问题） |
| `redesign/attach-icon.tsx` | 12 | `iconFor`：附件类型 → 图标 |
| `redesign/shared-ui.ts` | 26 | `basename` / `clipName` / `IS_MAC` / `DEFAULT_PERSONA_ID` |

`ChatFirstShell.tsx` 7,102 → **3,743 行**（−47%）。

## 三、依赖规则（新增代码必须遵守）

拆分能成立，靠的是这两条单向依赖：

```
shell-bits.tsx   ──┐
shared-ui.ts     ──┼──►  被各面板 import
attach-icon.tsx  ──┘

ChatFirstShell.tsx ──► import 各面板
```

**任何被拆出的面板都不得 import `ChatFirstShell.tsx`。**
一旦需要外壳里的东西，先问它该不该下沉到 `shell-bits` / `shared-ui`，或者改成 props 传入。

`shell-bits.tsx` 的存在就是为了打断这个环：任务面板与 Git 面板都要用右键菜单、新建菜单、拖拽条、相对时间，如果这些留在外壳里，两个面板就得反向依赖外壳。

## 四、为什么剩下的拆不动

三次尝试（Composer、Rail，以及更早的 Tasks 首轮）都失败，原因一致：

**这些"组件"其实是外壳状态的视图层，不是可独立搬运的模块。**

具体表现：

1. **直接读全局 store**：`useChat()` 一次解构十几个字段（sessions / currentSessionId / messages / streaming / streamStatus / sessionStates / send / stop / newSession / selectSession / deleteSession / renameSession / setArchived / deleteSessions / deleteTurns / currentBinding / draftSession / mountFocus / respondAsk / respondPlan / respondMount / onInsertsReturned）
2. **接收大量回调 props**：Rail 与 Composer 各自有 15～20 个 `onXxx` 回调，全部由外壳定义
3. **共享模块级可变状态**：`composerDrafts`、`draftListeners`、`liveComposer`、`activeTurns` 等，搬走就要连带搬状态与订阅

强行搬的后果：`tsc` 一次报出 40+ 个缺失标识符，补完一轮又暴露第二轮（因为同一符号在外壳别处也在用）。

## 五、剩余体量分布

`ChatFirstShell.tsx` 3,743 行：

| 块 | 约行数 | 可拆性 |
|---|---|---|
| 外壳主组件（状态编排 + 布局 + 弹窗挂载） | ~600 | 难，是中枢 |
| `Conversation` / `ConvMessage` / `TurnIndex` / `UserText` | ~900 | 中，依赖 store 状态多 |
| `Composer` + `ModelPicker` + `EffortPicker` | ~820 | 高，需先抽 hook |
| `Rail` / `IconRail` / `ThreadRow` / `PersonaRow` | ~700 | 中 |
| 其余小件（Avatar / 拖拽 / 杂项） | ~700 | 低 |
| `groupTurns` 等纯函数 | ~100 | 低，可随时搬 |

`chat.ts` 4,803 行：

| 块 | 约行数 | 可拆性 |
|---|---|---|
| `registerChatIpc`（IPC 注册 + runTurn + runAgentLoop） | ~3,000 | 高难度，闭包状态 |
| 类型定义与纯函数（display / nudge / subagent tools） | ~1,800 | 低，可继续搬 |

## 六、下一步方案（按顺序）

### 阶段 A：继续搬纯函数（低风险）

- `chat.ts` 的 `toDisplayMessages` / `turnRanges` / `deleteTurns` / `repairDanglingToolUses` → `chat/display.ts`
- `truncatedNudge` / `stepLimitNudge` / `repeatReminder` / `repeatStopNudge` / `EMPTY_NUDGE` → `chat/nudges.ts`
- `ChatFirstShell` 的 `groupTurns` → `redesign/message-groups.ts`

预计再减 ~500 行，机械操作，tsc 可完全验证。

### 阶段 B：抽 `useShellState()`

把外壳里这些状态收进一个 hook：

```ts
// redesign/use-shell-state.ts
export function useShellState() {
  return {
    sessions, currentSessionId, tab, setTab,
    editor, setEditor, settingsOpen, setSettingsOpen,
    tasksTarget, setTasksTarget, profileId, setProfileId,
    // …以及派生的 openSettings / openEditor / openProfile
  }
}
```

外壳与各面板都从它取，不再各自拼 `useChat()`。

### 阶段 C：面板改成 props 注入

`Rail`、`Composer` 接收显式 props（`sessions`、`onSelect`、`draft`、`onSend`…），不再直接调 store。
这样它们才能独立成文件，也才能单独写测试。

### 阶段 D：`chat.ts` 状态层

把 `activeTurns` / `busySessions` / `pendingAsk` / `pendingPlan` / `pendingMount` / `pendingInserts` 等模块级 Map 收进一个 `ChatRuntime` 类或闭包工厂，`registerChatIpc` 只负责注册与转发。

这是最大的一块，建议单独排期，不要和 UI 拆分混在一起做。

## 七、每次拆分的验证流程

```bash
# 1. 类型检查（两套配置）
npx tsc --noEmit -p apps/desktop/tsconfig.node.json --composite false
npx tsc --noEmit -p apps/desktop/tsconfig.web.json  --composite false

# 2. 构建
cd apps/desktop && npx electron-vite build
```

Windows 上若报 esbuild `Access is denied`，把 `TMP` / `TEMP` 指到仓库内目录再跑。

**判定标准**：两套 tsc 与 build 全绿才算完成；出现循环依赖或大面积缺失标识符，立即回退，不要留半成品。

## 八、经验教训

1. **先搬叶子，后搬中枢**。`settings` / `tasks` / `git` / `profile` 能拆，是因为它们只依赖 store 与 UI 组件；`Composer` / `Rail` 拆不动，是因为它们持有外壳状态。
2. **共享小件要先下沉**。`shell-bits.tsx` 是任务与 Git 能拆的前提。
3. **边界用结构锚点，不要用文案匹配**。Rail 首次失败就是把「定时任务标签页」当锚点，而 IconRail 的 tab 文案里也有这几个字，切出了 1,500 行的错位段落。
4. **失败的尝试要完整回退**。三次失败的拆分都没有留在工作区，当前代码始终是可编译状态。
