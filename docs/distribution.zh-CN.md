# Windows 安装与发布

## 使用安装版

从 [GitHub Releases](https://github.com/YvanLouise/aiscripter-for-ani/releases) 下载 `AIScripter-for-ani-0.1.0-x64-Setup.exe`，运行后选择安装目录。安装程序创建桌面和开始菜单快捷方式，可在 Windows 设置中卸载。首版为 Windows x64 预览版；不需要另装 Node.js、npm 或 FFmpeg。

应用、文档、SDK、示例和编码器一起安装。首次打开会在 `%APPDATA%\aiscripter-for-ani\default-animation-project` 创建可编辑的默认工程。应用更新和卸载保留用户数据；自己的工程建议保存在独立的工作目录。项目菜单可以打开规范，也可以复制规范给外部 AI。

本版没有配置代码签名证书。Windows 可能显示未识别发布者；请核对下载来源及发布页的 `SHA256SUMS.txt`。发布页同时提供编码器的完整对应源码 `third-party-sources.tar.gz`。

## 安装版 MCP

安装后的可执行文件也可以启动本机 stdio MCP：

```json
{
  "mcpServers": {
    "aiscripter": {
      "command": "C:\\Users\\YOUR_NAME\\AppData\\Local\\Programs\\AIScripter for ani\\AIScripter for ani.exe",
      "args": ["--mcp", "--project", "D:\\animations\\my-project"]
    }
  }
}
```

把 `command` 替换为实际安装路径；`--project` 指向工程目录。使用方式、会话连接、离线提交与权限边界见[本机 MCP 服务](mcp-local.zh-CN.md)。这个命令使用应用内置运行时，不依赖系统 Node.js。

## 从源码制作安装包

Windows 构建机需要 Node.js 22、npm 和 Git。先取得版本匹配的 FFmpeg 构建产物：

1. 在 GitHub Actions 中运行 `ffmpeg-build`，等待成功。
2. 下载 `ffmpeg-win64` artifact，解压到源码目录 `.build/ffmpeg/`。应得到 `runtime/ffmpeg.exe`、`runtime/manifest.json` 和 `third-party-sources.tar.gz`。
3. 执行：

```powershell
npm ci
npm run dist:win
npm run test:packaged
node scripts/release-checksums.mjs
```

输出目录为 `release/`。`win-unpacked/` 是可直接运行的打包目录；`*-Setup.exe` 是支持选择安装位置的 NSIS 安装程序。也可用 `npm run pack:win` 仅构建打包目录。打包过程检查编码器 SHA-256、源代码版本、对应源码包和第三方许可文件，缺少时拒绝打包。

`test:packaged` 直接运行打包后的应用：检查默认工程、三个程序场景、本机 TypeScript 编译、MCP、文档和资源、缩略图与波形、预览隔离及保存重开，完整导出 540 帧 1080p30 H.264/AAC，并检查 WebM/Opus 和 GIF。截图、视频与报告在 `.qa/packaged/`。它使用临时工程和配置，不修改个人工程。

## 编码器源码和许可证

应用代码采用 MIT。Electron、Chromium 和 npm 依赖保留各自许可，随包放在 `resources/licenses/`。内置 FFmpeg 独立运行，启用 x264 后采用 GPL-3.0-or-later；它的许可及依赖说明在 `resources/ffmpeg/`，完整对应源码放在同一发布页。

编码器版本和所有依赖固定在 `build-resources/ffmpeg-sources.json`。`scripts/build-ffmpeg.sh` 在 Ubuntu 24.04 使用 MinGW 构建 Windows x64 静态可执行文件，启用 H.264、VP8/VP9、Opus、AAC、PNG 和 GIF；网络协议及 nonfree 组件关闭。源码包包含全部五个源代码归档、归档校验、构建脚本、配置和工具链记录，内部 README 提供重建命令。开发环境的旧 npm FFmpeg 回退包不会进入安装包。

## GitHub 发布流程

`ci` 在推送和 PR 时执行源码构建、测试、MCP 测试与默认工程严格校验。`release` 工作流在 `v*` 标签触发：构建匹配的编码器，制作 Windows 安装包，验证实际打包程序，生成 SHA-256，再上传安装包和对应源码。标签版本必须与 `package.json` 一致。

首版以预发布方式提供。发布前应完成一次安装、启动与卸载验证；版本发布后保留安装包、对应源码和校验文件。若配置 Windows 签名证书，应使用 GitHub Secrets 注入 `CSC_LINK` 与 `CSC_KEY_PASSWORD`，并调整 `electron-builder.yml` 的签名选项，证书不进入仓库。
