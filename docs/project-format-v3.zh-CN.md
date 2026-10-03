# v3 程序场景与动画 SDK

适用于当前源码版。格式 v3、运行接口 `1.0.0`，支持 SDK `1.0.0` 和 `1.1.0`；对象编辑与组件实例使用 `1.1.0`。以 [v3 工程 Schema](../schema/project-v3.schema.json)、[v3 场景 Schema](../schema/scene-v3.schema.json)及 [SDK 类型与实现](../src/sdk/index.ts)为准。其余图层、裁剪、音轨和导出字段沿用 [v2](project-format-v2.zh-CN.md)。两个 v3 Schema 引用现有 v2 Schema，供外部校验器使用时须一起注册。

## 采用与兼容

新建空工程仍采用 v2。添加程序场景，或通过 MCP 提交 `enable_programs`，才明确升级到 v3。仅打开 v1/v2 工程不会改变其 custom 脚本的每帧初始化或随机种子语义。v3 内的旧 custom 图层也继续使用旧适配器。

首次将 v1/v2 保存为 v3 时，软件把升级前全部可见工程文件复制到 `.aiscripter-backups/v<原版本>-<UUID>/`，包括素材和源代码；不复制隐藏会话与缓存。原始文件仍在该备份中。工程清单新增三个必填字段：

```json
{
  "formatVersion": 3,
  "runtimeVersion": "1.0.0",
  "sdkVersion": "1.1.0",
  "capabilities": ["canvas-scene", "webgl2-scene"]
}
```

这里展示新增字段；完整清单还必须包含 v2 的工程 ID、名称、宽高、fps 和场景引用。未知 SDK、运行接口版本或能力会被拒绝。当前依赖固定为应用随附 SDK；没有第三方依赖安装、项目 npm 脚本执行或依赖锁文件接口。

## 场景配置

```json
{
  "id": "program",
  "name": "Program scene",
  "durationFrames": 300,
  "program": {
    "entry": "scripts/main.ts",
    "renderer": "2d",
    "seed": 2026,
    "params": { "title": "Hello", "speed": 1 }
  },
  "layers": []
}
```

`program` 可选。未填写的场景仍是原生场景；填写后程序画面先渲染，`layers` 中原生图层叠加其上，旧场景音频继续播放。`renderer` 为 `2d` 或 `webgl2`，须声明对应能力。`seed` 为 0–4294967295 的整数，`params` 值只允许有限数字、字符串和布尔值。程序入口须为 `scripts/` 内 `.ts` 或 `.mjs` 文件。

帧仍使用场景源动画的局部帧，`clip` 不改变源时间。复制或分割会生成新场景与原生图层 ID，保留入口、显式种子、参数和人工覆盖。对象 `nodeId` 在各场景实例内稳定，由代码定义；组件子对象使用实例前缀。`program.edits` 与公开参数、组件实例的完整接口见[第三轮规范与记录](ai-creation-phase-3.zh-CN.md)。

## TypeScript、组件与构建

源代码位于 `scripts/` 或 `components/`，允许 `.ts`、`.mjs` 及子目录，禁止隐藏路径。单文件最大 1 MB，源代码总计最大 8 MB。

可导入 `@aiscripter/sdk` 和上述目录内的相对模块；相对引用可以省略扩展名，也可引用目录中的 `index.ts` / `index.mjs`。不支持 Node 内置模块、裸 npm 包、网络 URL、项目外路径、`require()` 或计算式 `import(variable)`。宿主使用固定编译配置，不读取工程 `tsconfig`、构建插件或包安装脚本。TypeScript 按严格模式检查，`.mjs` 提供语法与模块检查，但不等同于完整 TypeScript 类型校验。

编译结果缓存于应用内存，源码和素材即可重建工程。一个程序入口失败不会阻止独立入口或原生图层编辑。`build_project` 返回文件、行、列和错误信息。运行错误包含场景 ID、入口、局部帧和堆栈；堆栈位置可能指向编译后的模块。

## 生命周期

```ts
import { defineScene, text, shape, ease } from '@aiscripter/sdk';

export default defineScene(async ({ width, height, seed, resources }) => {
  // 数据、图片和字体在这里预加载一次。
  const data = await resources.json<{ title: string }>('assets/data.json');
  return {
    evaluate({ frame, time, params }) {
      return [
        shape('background', { width, height, fill: '#0b1624' }),
        text('title', String(params.title ?? data.title), {
          x: 160, y: 200, fontSize: 100, fill: '#ffffff',
          opacity: ease.outCubic(time / 0.6),
        }),
      ];
    },
    dispose() { /* 释放自己创建的额外资源。 */ },
  };
});
```

- `create` 是默认导出的工厂。上下文提供画幅、fps、源时长、种子、Canvas/2D/WebGL2 上下文及只读资源 API。
- `evaluate` 接收局部整数 `frame`、秒数 `time`、当前参数和绘制上下文，返回对象树；直接绘制模块可返回 `void` 并实现 `render`。
- Canvas 对象树默认由 SDK 绘制；自定义 `render` 可接管绘制。WebGL2 场景须自己实现 `render`。
- `dispose` 在缓存淘汰或修订替换时调用，最长等待 500 ms；超时、崩溃、页面关闭则终止 Worker，不保证用户清理回调执行。

每个实例串行执行并复用 Worker、初始化和资源，单窗口最多保留 6 个实例。代码、项目修订、种子、渲染器、画幅、fps 或源时长改变后重建；未保存的单纯参数调整可以直接重新求值。每帧上限 8 秒，包括首次加载与初始化，超过上限会终止整个 Worker。下一次请求会新建实例；用户也可点击“重建预览实例”。

## 对象与动画 API

| 分类 | 当前接口 |
| --- | --- |
| 对象 | `group`、`shape`、`text`、`image`、`customSurface` |
| 变换 | 位置、缩放、角度、锚点、父子坐标、透明度、可见性 |
| 绘制 | 矩形/椭圆/线/SVG 路径、圆角、描边、多行文字、图片、矩形裁切 |
| 时间 | `interpolate`、`ease`、`spring`、`stagger`、`loop`、`samplePath` |
| 布局 | `grid`、`center` |
| 随机 | `random(seed, channel, index)`、`noise(seed, channel, time)` |
| 资源 | `resources.read/text/json/image/font` |

坐标原点是左上角，角度以度计。锚点为宽高的比例（默认 0），变换依次为位置、旋转、缩放、锚点平移，再绘制子对象。分组透明度相乘；`clip: true` 使用当前对象的矩形边界。图片默认原尺寸；同一图片可在多个对象中复用。

对象 ID 不能缺失或重复，不能形成父子循环；每次最多 10000 个对象、64 层嵌套。数字必须有限，宽高非负，透明度为 0–1。描述接口返回父子地址、变换矩阵、世界选框、裁切、代码值、有效属性和锁定状态；界面可选择、移动、缩放、旋转和编辑程序内部对象。

资源 API 仅在 `create` 期间加载 `assets/` 内文件；禁止隐藏路径、越界、写入、网络和系统权限，单次资源最大 64 MB。字体使用 `await resources.font('Family', 'assets/font.woff2')`，然后在文字节点中设置 `fontFamily: 'Family'`。系统字体与本机有关；需要可移植输出时应随工程提供字体。程序场景中的视频目前通过原生 `video` 图层叠加，尚无 SDK 视频节点。

## 确定性约定

同一画面须仅取决于指定帧、参数、种子和资源，不得依赖先前访问帧的顺序。随机效果使用稳定对象/通道名；真实时钟被替换为指定帧时间，`Math.random`、系统随机、计时器和直接网络 API 不可用。缓存资源与预计算常量可以保存，累计模拟状态不能混入 `evaluate`。

软件无法把任意有状态 JavaScript 自动变成纯函数；开发者须遵守此接口约定，并用乱序和重复帧截图检查。对象覆盖与参数关键帧已接入；连续物理/粒子模拟、状态快照和专用 Three.js 适配属于后续阶段。

## 使用入口与验收工程

编辑器左侧场景标题旁的代码图标用于“添加程序场景”。在图层区点击“程序场景 · 参数与代码”可调参数、编辑入口或组件，并查看编译错误；操作进入同一草稿与撤销历史。

`examples/program-scenes/project.json` 是 15 秒、450 帧的混合示例：原生标题、类型化卡片组件、100 个确定性背景粒子、JSON 数据、SVG 图片、可编辑原生覆盖图层及跨场景音轨。

MCP 推荐流程：读取 `format_v3` 和 `sdk` → `stage_changes`（需要时先 `enable_programs`，再写模块和场景）→ `commit_changes` → `build_project` → `render_frames` → `get_diagnostics` → `export_preview` → `save_project`。结构合法但代码编译失败时允许保存以便修复，导出会报告具体错误。

命令行校验可使用 `npm run validate:project -- examples/program-scenes --strict-assets --build`；`--build` 同时进行程序类型与模块检查。历史运行时验收见[第二轮记录](ai-creation-phase-2.zh-CN.md)，当前编辑接口与验收见[第三轮记录](ai-creation-phase-3.zh-CN.md)。

构建由 [esbuild 插件](https://esbuild.github.io/plugins/)拦截模块解析，执行环境继续使用 [Electron 的隔离与权限限制](https://www.electronjs.org/docs/latest/tutorial/security)。
