# AIScripter 项目文档

适用软件：AIScripter for ani `0.1.0`。编辑器读取 v1/v2/v3；新建空工程采用 v2，添加程序场景时采用 v3（SDK 1.1.0，兼容 1.0.0）。软件版本与工程格式版本是两件事：判断文件格式应读取 `project.json.formatVersion`。

## 从这里开始

| 读者与任务 | 文档 |
| --- | --- |
| 安装软件、制作安装包和发布版本 | [Windows 安装与发布](distribution.zh-CN.md) |
| 外部 AI 第一次创建或续改工程 | [外部 AI 创作与续改规范](external-ai-workflow.zh-CN.md) |
| 查询字段、时间计算、脚本接口和限制 | [v2 工程格式中文规范](project-format-v2.zh-CN.md) |
| 查询简明英文契约 | [Project format v2](project-format-v2.md) |
| 使用 TypeScript、程序场景和可复用组件 | [v3 程序场景与 SDK](project-format-v3.zh-CN.md) |
| 调整程序对象并保留人工修改 | [第三轮：对象编辑、实例参数与覆盖](ai-creation-phase-3.zh-CN.md) |
| 播放、编辑或续改默认品牌动画 | [默认动画分镜与编辑指南](../examples/default-animation/README.zh-CN.md) |
| 在外部 AI 工具中接入本机工程信息 | [本机 MCP 服务](mcp-local.zh-CN.md) |
| 维护旧工程 | [Project format v1](project-format-v1.md) |
| 检查实际允许的字段 | [project.schema.json](../schema/project.schema.json)、[scene.schema.json](../schema/scene.schema.json) |

可运行示例：[默认动画工程](../examples/default-animation/README.zh-CN.md)展示 18 秒三幕品牌短片、可编辑标题、组件实例与原创配乐；`examples/program-scenes/` 展示 v3 混合场景与类型化组件；`examples/sequence-v2/` 展示连续场景与全局音轨；`examples/solar-system/` 展示 v1 兼容；`examples/engine-showcase/` 展示自定义脚本、表达式、视频与 3D；`examples/transparent-layer/` 展示透明输出。

在软件的 **工程菜单** 中可直接打开这些文档。选择 **复制规范给外部 AI** 会把创作规范、v1/v2/v3 字段文档、SDK 和 Schema 一起复制到剪贴板，适合外部 AI 无法访问本机工程目录时粘贴使用；软件不会自动发送内容。

## 校验工程

在软件中选择 **工程菜单 → 检查工程**。外部 AI 可在源码目录运行同一套加载与检查逻辑：

```powershell
npm run validate:project -- "D:\path\to\project"
npm run validate:project -- "D:\path\to\project" --strict-assets
```

也可传 `project.json` 文件路径。结构错误、重复 ID、无效时间范围和越界路径返回非零退出码。默认情况下，缺失或不可访问的资源是警告，因为编辑器允许修复；`--strict-assets` 会把这类资源警告视为失败。音频延伸到视频结尾之后属于单独的提示，不受此开关影响。资源本身能否被当前 Chromium 解码、WebGL2 能否运行及自定义脚本的画面效果，还须在软件中预览和导出验证。

## 文档优先级

创建或修改工程时，先读取与 `formatVersion` 对应的文档，再参考 Schema 和合法示例。Schema 限定字段形状；编辑器还会检查跨文件关系、时间范围、路径安全和音轨重叠。本文档描述当前已实现的能力；不要把设计稿中的未来功能当作现有工程字段。

## 架构优化提案

[AI 创作能力优化方案](ai-creation-optimization-plan.zh-CN.md)提出分阶段路线。首轮已接入 MCP 草稿修改、事务恢复、截图和短片作业，见[首轮实施记录](ai-creation-phase-1.zh-CN.md)。第二轮接入 v3 程序场景、类型化 SDK、本机构建与常驻 Worker，见[v3 规范](project-format-v3.zh-CN.md)与[第二轮验证记录](ai-creation-phase-2.zh-CN.md)。第三轮接入对象逐项编辑、公开参数与组件实例关键帧、人工覆盖保留及失效恢复，见[第三轮记录](ai-creation-phase-3.zh-CN.md)。模拟快照和新 3D 适配属于第四轮。
