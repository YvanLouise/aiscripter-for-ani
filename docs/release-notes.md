## AIScripter for ani 0.1.0 预览版

Windows x64 动画编辑器，面向外部 AI 创建和续改工程。

- 安装程序支持选择目录、桌面快捷方式、开始菜单和卸载；内置运行时与编码器。
- 默认 18 秒三幕动画《灵感开始流动》，含可编辑标题、类型化组件、品牌图标和原创配乐。
- 连续场景时间轴：缩略图、音频波形、裁剪、分割、排序、全局播放头、滚轮缩放和中键平移。
- 图层与关键帧、程序对象与人工覆盖、撤销重做、自动保存、外部修改检测和冲突处理。
- TypeScript SDK、Canvas/WebGL2 程序场景，以及本机 stdio MCP 的 18 项创作工具。
- PNG、MP4、WebM、GIF 和 PNG 序列导出；附工程规范、Schema 和示例。

### 安装

下载 `AIScripter-for-ani-0.1.0-x64-Setup.exe`。不需要额外安装 Node.js 或 FFmpeg。应用更新及卸载保留用户数据。安装版 MCP 使用 `AIScripter MCP.exe --project <工程目录>`。

本版安装程序未签名，Windows 可能提示未识别发布者。下载后可用 `Get-FileHash <安装包路径> -Algorithm SHA256` 与 `SHA256SUMS.txt` 核对。

### 许可与当前范围

应用源码采用 MIT；第三方组件保留各自许可。内置 FFmpeg 9.0.2 编码器采用 GPL-3.0-or-later；本发布的 `third-party-sources.tar.gz` 提供其全部对应源码、依赖和重建脚本。

这是本机预览版，不包含内置 AI 模型、云端渲染、团队协作、自动更新、模拟快照或新的 Three.js 程序适配器。已有工程格式 v1/v2/v3 均可打开。详见仓库的工程规范与安装发布文档。
