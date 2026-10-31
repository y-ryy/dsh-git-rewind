# dsh-git-rewind

DeepSeek Harness 的**就地消息撤回**插件：选择一条已发送的用户消息，把它和之后的内容从模型上下文与对话界面中撤回，同时可选用 **Git 检查点**还原工作区文件。右侧栏还提供一个 Git 版本可视化面板，可查看本插件的检查点图谱和真实仓库的只读提交历史。

> 会话日志始终只追加：撤回通过 DSH 官方的 `surfaceOp: { op: 'replace' }` 机制写入一个空消息占位符，不删除、不改写任何历史事件。文件检查点保存在插件私有的 Git 仓库中，不碰你项目自身的 `.git`、index、HEAD 或提交历史。

## 安装

从 GitHub 安装：

```sh
dsh plugin add github:y-ryy/dsh-git-rewind
```

桌面端打开 **设置 → 插件 → 添加插件**，填入 `github:y-ryy/dsh-git-rewind`，安装后刷新页面或重启 DSH。其他 profile 可用 CLI：

```sh
dsh plugin --profile web add github:y-ryy/dsh-git-rewind
```

也可以克隆后从本地目录安装：

```sh
git clone https://github.com/y-ryy/dsh-git-rewind.git
dsh plugin --profile web add ./dsh-git-rewind
```

依赖：DSH `0.2.1-rc.2` 左右版本、系统 `git`（`git --version` 可用）。没有 Git 时消息撤回仍可用，文件还原会明确提示不可用。

## 使用

### 从界面撤回

1. 在你发送的**用户消息下方**、内置「复制」按钮右侧，点击 ↶ **撤回消息** 图标（也可以在右侧栏的 **Git 版本** 面板中点击检查点节点）。
2. 选择要撤回的消息；弹窗显示原文、文件变更清单和模式：
   - **仅撤回消息**：对话回到该消息之前，文件不动；
   - **撤回消息并还原文件**：同时把工作区还原到该轮开始前的 Git 检查点；
   - **仅还原文件**：只还原文件，不改动对话。
3. 确认后，消息及其之后的内容从模型上下文和界面中消失，原文回到输入框，修改后可直接重发。

### 从命令撤回

```text
/rewind                 列出可回退消息（最新在前）
/rewind <n>             预览第 n 条消息（不执行）
/rewind <n> --messages  仅撤回消息
/rewind <n> --files     撤回消息并还原文件
/rewind <n> --files-only 仅还原文件
```

## 右侧栏 Git 可视化

右侧栏标签页 **Git 版本** 有两个视图：

- **回退检查点**：用泳道图显示本插件为每个用户轮次创建的 Git 检查点。每个会话是一条分支/泳道；点击节点查看该轮消息、文件清单和 diff，可直接回退。
- **仓库历史**：只读显示当前工作区真实 Git 仓库的分支、ahead/behind、未提交文件数和最近提交的泳道图；点击提交查看元信息与文件清单，点击文件查看 unified diff。这个视图不会执行任何写操作。

搜索框支持按消息、提交 subject、作者或 hash 过滤。检查点视图可在「仅当前会话 / 全部会话」之间切换。

## Git 存储

```text
$DSH_HOME/storages/dsh-git-rewind/
  repos/<workspaceHash>/.git/       # 每个工作区一个私有仓库
  sessions/<sessionId>.json         # 检查点索引
  quarantine/<sessionId>/<slot>/    # 被替换/新增文件的隔离副本
```

每个工作区使用一个私有仓库，`core.worktree` 指向真实工作区。检查点以会话为单位串成 `refs/dsh-git-rewind/<sessionId>` 引用；可以像普通仓库一样查看：

```sh
git --git-dir="$DSH_HOME/storages/dsh-git-rewind/repos/<workspaceHash>/.git" log --all --oneline --decorate
```

`.git`、`node_modules`、`.dsh`、`dist`、`build`、`coverage`、`.next`、`__pycache__`、`.venv`、`venv` 默认不参与检查点；工作区自己的 `.gitignore` 也会生效。可通过插件配置的 `exclude` 追加排除目录。

### 隔离区

还原前，插件会先创建一个救援检查点。被覆盖的文件会先硬链接/复制到隔离区；检查点之后新增的文件会移动到隔离区，而不是删除。每个隔离槽都有 `manifest.json` 记录原始路径。确认无误后可手动删除：

```sh
rm -rf "$DSH_HOME/storages/dsh-git-rewind/quarantine/<sessionId>"
```

## 会话、分支与工作区语义

| 场景 | 处理方式 |
|---|---|
| 不同工作区 | 每个工作区一个独立影子仓库（按 `sha256(cwd)` 取前 16 位作目录名），检查点、索引、隔离区完全隔离；图谱只显示当前工作区的会话。 |
| 同一工作区的不同会话 | 共享同一个影子仓库；每个会话有独立的 `refs/dsh-git-rewind/<sessionId>` 引用与检查点链（各自的首个检查点是根提交）。仓库级锁串行化 Git 操作，共享的影子 index 只是"当前树"的暂存区，不含会话状态。**注意**：文件还原是工作区级的——会话 A 回撤会把整个工作区还原到 A 的检查点，同一目录下会话 B 在此之后的文件改动会被隔离而非删除。若还原时有其他同目录会话正在运行回合，会拒绝并提示 busy。 |
| 分支会话（fork 出的子会话） | DSH 的 fork 会创建新的 sessionId；子会话在自己的链上从头建检查点，与父会话互不影响，可独立回撤。图谱中子会话是一条独立泳道并带「分支」徽标（悬停显示父会话 ID）。 |
| 同一会话的多次回撤 | DSH 没有同 ID 的会话内分支；每次回撤只是追加一个占位事件，检查点链继续向后串。被撤回的轮次在 Git 历史里仍可审计。 |
| 删除会话 | 会话日志删除后，检查点索引、Git 引用与隔离区默认保留（可审计/取证）。图谱中该会话显示「已删除」徽标；消息撤回不可用，但**仍可在面板中把工作区文件还原到它的某个检查点**（走 turn 寻址，先建救援点并隔离现有文件）。 |

子代理会话（`origin: 'subagent'`）不创建检查点，由父会话的检查点统一覆盖其文件改动。会话中途切换工作目录后，旧检查点不再适用，插件会跳过后续检查点创建（消息撤回不受影响）。

## 安全边界

- 不修改用户仓库的 `.git`、index、HEAD、refs，不执行 `git clean`、`git reset --hard` 或 `git checkout`。
- Git 命令一律以 argv 数组执行，不拼接 shell 字符串；路径必须是工作区内的相对路径，拒绝 `..`、绝对路径和符号链接父目录。
- 检查点创建失败（超时、Git 不可用、工作区不可读）只记录跳过，不阻塞用户回合；撤回时会明确提示“只能撤回消息”。
- 会话正在运行时拒绝撤回；另一个进程持有会话写锁时返回 `writer-held`，不会修改文件。
- 还原失败会按救援检查点回滚，并把隔离文件放回原位；结果中报告失败原因和救援提交。

## 配置

在 `cordis.patch.yml` 的 `git-rewind` 行下配置：

```yaml
- id: git-rewind
  name: dsh-git-rewind
  config:
    gitPath: git
    snapshotTimeoutMs: 15000
    previewLimit: 500
    checkpointGraphLimit: 200
    repoGraphLimit: 200
    diffMaxBytes: 262144
    exclude: []
    prefillComposer: true
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `gitPath` | `git` | Git 可执行文件 |
| `storageDir` | `$DSH_HOME/storages/dsh-git-rewind` | 检查点数据根目录 |
| `snapshotTimeoutMs` | `15000` | 单次检查点超时 |
| `previewLimit` | `500` | 预览最多文件数 |
| `checkpointGraphLimit` | `200` | 右侧栏检查点图谱上限 |
| `repoGraphLimit` | `200` | 真实仓库图谱上限 |
| `diffMaxBytes` | `262144` | 单文件 diff 上限 |
| `exclude` | `[]` | 追加排除目录 |
| `prefillComposer` | `true` | 成功后回填输入框 |

## 已知限制

- 撤回只覆盖 **模型可见表面**：被撤回内容仍保留在 append-only 会话日志中，可在轨迹/日志中审计。
- 目标消息早于最近一次 compaction 时无法撤回，弹窗和命令会明确说明。
- 插件安装前创建的消息没有文件检查点，只能撤回消息。
- 不还原 `.git`、`node_modules` 等排除目录，也不保留 ACL、mtime、所有权；Windows 下执行位按 Git 配置处理。
- 不做 fork/分支回退、不做提交/暂存/分支/推送等 Git 写操作。
- 右侧栏面板只读真实仓库；检查点仓库由插件维护。

## 架构

```text
index.js                  Host 入口：每轮 pre-step 捕获、命令注册、投影与路由接线
src/anchors.js            锚点枚举、compaction 边界、surface 裁剪、占位消息
src/git-store.js          私有 Git 仓库、检查点、预览、还原、隔离、救援点
src/git-repo.js           真实仓库只读查询（status/log/show/diff）
src/graph-model.js        检查点索引/仓库日志 → 图谱模型
src/projection.js         gitRewind 会话投影（隐藏轮次 + 锚点列表）
src/rewind-service.js     preview/apply 统一业务逻辑
src/routes.js             /api/plugins/dsh-git-rewind 路由
client.js                 右侧栏面板、回退弹窗、SVG 泳道图
```

实现参考了 DSH 生态中若干 Git/回退插件的交互与工程做法，代码独立实现：`xbzbing/dsh-git-panel`、`AKS1st/dock-git`、`LiangshouX/dsh-ide-workbench`、`Dayi-Z/dsh-git-manager`、`2002XiaoYu/dsh-session-diff`。

## 开发

```sh
node --check index.js client.js
node --test test/*.test.js
```

Git 集成测试需要真实 `git`；测试只使用系统临时目录，不触碰你的真实工作区。

## License

MIT
