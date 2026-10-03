# 本机 MCP 服务

AIScripter 提供本机 **stdio MCP** 创作服务。外部 AI 可以读取未保存草稿，按 ID 提交修改，查看 PNG 截图和诊断，并导出 MP4 短片。服务绑定 `--project` 指定的工程目录，不需要云端服务器。Windows 编辑器通过带随机会话令牌的命名管道连接；连接信息在工程的 `.aiscripter/mcp-session.json`，不要提交或分享这个文件。

## 构建与接入

安装版可以直接将安装目录中的 `AIScripter MCP.exe` 配为服务器命令，参数为 `["--project", "工程绝对路径"]`，无需安装 Node.js。完整配置示例见[Windows 安装与发布](distribution.zh-CN.md#安装版-mcp)。以下构建命令和 Node.js 配置适用于源码开发。

在 AIScripter 源码目录先执行：

```powershell
npm install
npm run build:mcp
```

如果已经通过 `Start AIScripter.cmd` 或 `npm run build` 构建过当前源码，MCP 文件也已生成，可跳过单独的构建命令。运行 `npm run test:mcp` 可检查 stdio 握手、工具调用、示例工程校验与路径限制。

然后在支持 MCP 的外部 AI 工具中添加本机 stdio 服务器。下面是**通用配置形状**；具体配置文件位置和字段名称以所用工具为准：

```json
{
  "mcpServers": {
    "aiscripter": {
      "command": "node",
      "args": [
        "D:\\MY procedure\\AIScripter for ani\\dist-tools\\aiscripter-mcp.cjs",
        "--project",
        "D:\\animations\\my-project"
      ]
    }
  }
}
```

把示例路径替换成实际绝对路径。`--project` 指向包含 `project.json` 的**工程目录**，必须与编辑器中打开的目录一致，可从工程按钮的提示中查看。省略该参数时文档和能力工具可用。切换工程应更新参数并重启连接。

编辑器打开工程时，工具读取当前草稿，包含人工尚未保存的属性和脚本。编辑器关闭时可以读取磁盘，但必须明确增加 `--offline` 才能提交磁盘修改；截图和短片需要打开编辑器。如果存在会话描述文件但连接失败，返回 `EDITOR_UNAVAILABLE`，不会偷偷改读磁盘。异常退出后，可重开编辑器恢复会话，或在确认旧进程已结束后使用 `--offline`。同一工程只能由一个编辑器拥有会话。

**源码版 MCP 客户端直接运行 `node dist-tools/aiscripter-mcp.cjs`；安装版运行 `AIScripter MCP.exe`。** 不要把 `npm run build:mcp` 或 `npm run` 配为服务器命令：npm 的启动输出会占用 stdout，而 stdio MCP 的 stdout 专用于 JSON-RPC。服务自身不在 stdout 打印日志。源码更新后重新运行 `npm run build:mcp`。

## 工具

| 工具 | 用途 |
| --- | --- |
| `read_documentation` | 读取规范和 Schema；新增 `format_v3`、`sdk`、`project_schema_v3`、`scene_schema_v3` |
| `get_capabilities` | 查询 v1/v2/v3、SDK 1.0.0/1.1.0、程序编辑、渲染器和运行限制 |
| `build_project` | 使用当前 `draft_revision` 检查类型、打包 v3 模块；返回文件/行/列诊断，不执行代码，可离线调用 |
| `get_session` | 获取模式、草稿修订、磁盘修订、未保存状态与播放头 |
| `inspect_project` | 获取完整当前草稿，包括图层属性、关键帧、音轨和脚本；保留原有 root/revision/manifest/scenes 返回字段 |
| `read_project_file` | 读取草稿 JSON/脚本或磁盘文本素材；上限 1 MB，拒绝路径越界 |
| `validate_project` | 校验当前草稿；`strict_resources: true` 将资源警告视为不通过 |
| `stage_changes` | 提交 1–100 项变更，返回差异与校验，不写入草稿或磁盘 |
| `commit_changes` / `discard_changes` | 提交或丢弃 stage；stage 10 分钟过期，修订变化时拒绝提交 |
| `save_project` | 使用编辑器正常保存路径立即持久化当前草稿 |
| `undo_offline_commit` | 使用离线 commit 返回的 undoId 和当前修订恢复提交前快照；仅适用 --offline，返回的新 undoId 可恢复被撤销版本 |
| `import_assets` | 导入一个不超过 8 MB 的 base64 素材，只允许 assets/ 下的新文件 |
| `render_frames` | 截取最多 6 个全局整数帧，返回 MCP PNG 图像、场景映射、图层错误和耗时；最大 1920×1080 |
| `get_diagnostics` | 获取结构/资源检查、程序编译诊断及该草稿最近一次截图的运行诊断 |
| `export_preview` | 提交最长 30 秒、960×540、工程 fps 的 H.264/AAC MP4 作业；范围为 [start_frame,end_frame) |
| `get_job` / `cancel_job` | 查询进度、输出文件和错误，或取消排队/运行作业；最多 4 个未完成作业 |

## 创作闭环

1. `get_capabilities` → `read_documentation` → `inspect_project`。
2. 从返回值取得 `draftRevision`、`diskRevision`，传给 `stage_changes.expected_draft_revision` 和 `expected_disk_revision`。
3. 检查 stage 返回的 `summary`、`check`，再调用 `commit_changes`，传 `stage_id`。
4. 重新获取会话，将当前 `draftRevision` 传给 `render_frames.draft_revision`，检查画面和 `errors`；修正后再截图。
5. 用 `export_preview` 检查节奏/音频，轮询 `get_job`。完成作业返回本机绝对路径。临时短片请复制到交付目录，编辑器退出后会清理会话临时文件。
6. `validate_project`，需要立即保存时调用 `save_project`。编辑器原有自动保存继续有效：commit 形成草稿，通常在 2.5 秒空闲后自动保存。

例：只调整已有背景参数（示例 ID 须换成当前工程 ID）：

```json
{
  "expected_draft_revision": "从 get_session 取得",
  "expected_disk_revision": "从 get_session 取得",
  "changes": [
    { "kind": "update_layer", "sceneId": "introduction", "layerId": "intro-stars", "patch": { "params": { "density": 0.5, "blue": 0.8 } } }
  ]
}
```

支持 `update_layer`、`add_layer`、`remove_layer`、`update_scene`、`add_scene`、`remove_scene`、`reorder_scenes`、`update_project`、`write_script`、`enable_programs`。新增图层/场景使用 `value` 传完整合法对象；排序的 `order` 包含全部场景 ID；脚本使用 `path` 和 `source`。`patch` 是浅替换，修改 params/keyframes 时应读当前映射并保留其他条目。ID 不能通过 patch 更改。场景 patch 允许 name/durationFrames/clip/program；工程 patch 只允许 name/width/height/fps/audioTracks。

采用程序场景时，在同一组变更中先加入 `{ "kind": "enable_programs" }`，再用 `write_script` 写入 `.ts` / `.mjs` 的 scripts/、components/ 模块，最后修改或新增场景的 `program` 配置。普通 v1/v2 脚本继续使用 scripts/ 下 `.mjs`。读取 [v3 与 SDK 规范](project-format-v3.zh-CN.md)后编写模块，commit 后调用 `build_project` 检查，再截图与导出。编译产物不进入草稿或持久化工程。结构合法但编译错误的草稿可保存以便修复。

锁定图层不能修改、删除或由 AI 解锁。工程中存在锁定 custom 图层时，脚本修改会被拒绝，因为共享依赖也可能改变该图层。结构与源代码共同进入一条编辑器撤销记录。导入素材立即写入新文件并更新修订基线；撤销恢复原有源代码与资源引用，不删除已导入素材或已保存的新增模块。这些未引用文件可以另行检查后手动清理。

## 保存与故障恢复

场景、清单与脚本作为一批保存，在 `.aiscripter/transactions/` 暂存新文件、保存原文件备份和写前日志。提交标记之前发生错误时恢复整批原内容；进程中断后，下一次加载恢复到最后完整版本。活动写入锁会返回 `PROJECT_BUSY`，不会边写边加载。v1 首次保存的升级备份继续保留。离线提交的撤销快照保存在 `.aiscripter/offline-undo/`，返回的 undoId 可以跨 MCP 重启使用；撤销不会删除新增的共享资源文件。

Windows 会话令牌文件取消继承权限，并仅向运行编辑器的当前用户授予访问；POSIX 使用 0600。客户端须在同一用户身份下运行。令牌不写入日志或 MCP 返回值。管道消息上限为 16 MB；复杂噪声画面应降低截图尺寸或减少帧数，以免整批 PNG 超出上限。

`REVISION_CONFLICT` 表示用户编辑、自动保存、素材导入或磁盘修改使旧 stage 失效，应重新读取并 stage，不能直接重试覆盖。`EDITOR_BUSY` 表示手势、脚本未应用内容、保存/导出或外部冲突尚未结束。

截图和短片使用冻结工程与隐藏渲染器，不移动用户播放头。作业串行执行；程序截图还返回实例 ID、是否初始化、求值/绘制耗时与节点数，`frames[].programEdit` 返回公开参数、对象树、代码值/有效值、变换选框、锁和覆盖失效提示。人工 edits 属于编辑器：update_scene 省略 edits 时保留，替换或删除现有 edits 时返回 HUMAN_OVERRIDES。锁定程序对象、属性或实例参数时拒绝共享模块修改、替换 program 及删除场景。详细地址与参数契约见[第三轮规范](ai-creation-phase-3.zh-CN.md)。并行渲染仍未接入。MCP 不授予动画脚本网络、Node.js、系统命令或工程外文件权限。当前共 18 项工具，MCP 服务版本 0.4.0。
