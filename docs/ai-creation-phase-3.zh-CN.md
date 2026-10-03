# 第三轮：程序对象编辑与人工覆盖

日期：2026-10-03。适用源码版；格式仍为 v3，运行接口 1.0.0，SDK 新增 1.1.0。SDK 1.0.0 工程仍可读取；第一次编辑程序对象或参数时，在草稿中声明 1.1.0，保存后持久化。v1/v2 的旧脚本运行语义保持兼容。

## 已实现

| 能力 | 操作与行为 |
| --- | --- |
| 对象树 | 程序属性面板显示 group、shape、text、image、surface 及组件实例；可展开和选择 |
| 画布编辑 | 按绘制顺序命中对象，识别父子变换、锚点及矩形裁切；选框可移动、缩放和旋转 |
| 属性覆盖 | 数字、文字、颜色、可见性与字体属性独立保存；数字支持绝对替换或相对代码值的偏移 |
| 公开参数 | number/string/boolean/color/enum 描述，默认值、数值范围、步长、名称及是否允许动画 |
| 关键帧 | 局部整数帧；◆ 添加/删除，修改动画属性自动写当前帧；支持改时间、跳转、线性/平滑/保持插值 |
| 组件实例 | `component()` 前缀化内部 ID，同一组件每个实例拥有独立参数、关键帧和内部对象覆盖 |
| 人工保留 | AI 更新模块后重新按稳定 ID 应用覆盖，代码值和覆盖记录分开存储 |
| 失效恢复 | 对象缺失、类型或属性改变、参数约束改变时保留记录并提示；可恢复原 ID、手动绑定同类型对象或清除记录 |
| 锁定 | 对象锁继承到子节点；可单独锁定属性和实例参数；MCP 拒绝可能影响锁定项的共享模块修改 |
| 草稿与导出 | 一次画布手势对应一次撤销；保存、重开、截图、PNG、短片与正式导出使用同一覆盖求值逻辑 |

拖动时仅在选框上更新临时反馈，松开后提交一次修改，避免每个鼠标事件触发编译、资源初始化或工程复制。

## SDK 示例

```ts
import { defineScene, component, text, shape } from '@aiscripter/sdk';

export default defineScene(() => ({
  parameters: {
    title: { type: 'string', default: 'Hello', label: '标题' },
    speed: { type: 'number', default: 1, min: 0.1, max: 4 },
    accent: { type: 'color', default: '#71dfcf' },
  },
  evaluate(context) {
    return [
      text('title', String(context.params.title), { x: 100, y: 80, fontSize: 60 }),
      component('metric-a', context,
        { value: { type: 'number', default: 50, min: 0, max: 100 } },
        { value: 75 },
        params => [shape('bar', { width: Number(params.value) * 4, height: 30 })],
        { x: 100, y: 240 }),
    ];
  },
}));
```

组件内部对象完整 ID 为 `metric-a/bar`。代码不得根据数组临时顺序或随机数生成编辑地址；嵌套组件应使用唯一的完整实例地址，参数作用域根据传给 `component()` 的实例 ID 查找。

## 持久化契约

覆盖保存在 `scene.program.edits`，随场景 JSON 参与修订、事务保存、撤销和工程复制。本轮未采用提案中的独立 `overrides/` 目录。

```json
{
  "parameters": {
    "title": { "value": "人工标题" },
    "speed": { "value": 1, "keyframes": [
      { "frame": 0, "value": 1, "easing": "smooth" },
      { "frame": 299, "value": 2 }
    ] }
  },
  "objects": {
    "title": { "type": "text", "properties": {
      "x": { "mode": "offset", "value": 75 },
      "fill": { "value": "#ffffff" }
    } }
  },
  "instances": { "metric-a": { "parameters": { "value": { "value": 88 } } } }
}
```

`value` 必填；`mode` 默认 replace；offset 只允许数字。keyframes 按时间严格递增、不能重复、不能超出场景源时长，值类型必须与 value 相同。数字和六位十六进制颜色连续插值，字符串/枚举/布尔值保持到下一帧。smooth 为三次平滑插值；hold 保持左侧值。裁剪使用源局部时间，不删除被裁剪的关键帧。

求值顺序：代码参数/默认值 → 人工场景参数与关键帧 → 实例参数与关键帧 → `evaluate()` → 对象覆盖与关键帧 → 同一渲染器绘制。对象 offset 在该帧代码值上相加，因此代码继续动画时保留人工偏移。

## 外部 AI 续改

1. 读取当前草稿、`format_v3` 与 `sdk`，保持工程、对象和实例 ID。
2. 修改模块或 program 的 entry/params 等代码配置，保留人工 edits。MCP 的 update_scene 未携带 edits 时自动保留；携带不同 edits 或删除 program 时返回 HUMAN_OVERRIDES。
3. `build_project` 校验后，调用 `render_frames` 检查 `frames[].programEdit`：参数定义、该帧值、对象树、世界选框、代码值与实际值、锁和失效诊断。
4. 使用 `get_diagnostics`、重复及乱序帧截图、`export_preview` 验证，再保存。

存在锁定对象、属性或参数时，MCP 保守拒绝所有模块编辑和可能影响对象的工程宽高/fps 修改，因为共享依赖和初始化上下文可以间接影响这些对象。存在人工覆盖的场景不能通过 MCP 删除，需在编辑器操作。用户可在编辑器中解除锁定，失效对象或实例的记录也提供解锁和清除入口。直接使用文件系统改工程的外部程序不受 MCP 变更检查控制；编辑器仍按已有外部修改和冲突规则处理。

## 验证入口与证据

```powershell
npm test
npm run test:object-edit
npm run test:programs
npm run test:mcp
```

本轮 `npm test` 共 18 个文件、64 项测试通过，`npm run test:mcp` 的两个协议版本、文档无工程读取、离线事务/撤销与 v3 检查通过。真实 Electron 对象编辑验收共 13 项，覆盖公开参数关键帧、画布移动/缩放/旋转、一次手势撤销重做、组件实例独立参数、MCP 锁定、AI 改代码保留覆盖、重复帧一致、失效 ID 提示/恢复和手动绑定、带编辑结果的短片导出、保存重开与非空界面。测试使用临时工程和配置，不改示例源文件。

旧程序场景另通过 13 项 Electron 检查，包括初始化复用、字体/SVG 资源、禁止越界/网络、超时及异常恢复、WebGL2、混合导出和保存。编辑后短片由 FFmpeg 完整解码验证：30 帧、960×540、30 fps、H.264/AAC。

当前证据输出：`.qa/object-edit/editor.png`、同名 `.json` 报告、`.frame.png` 截图和 `.preview.mp4`。测试报告还记录 PNG 的 SHA-256 和保留的覆盖内容。

## 实际边界与下一轮

- 命中测试基于变换后的对象边界，识别矩形 clip；路径与图片透明像素采用边界近似。文字用画布字体测量，group 使用子对象包围区域。
- 自定义 `render()` 收到应用覆盖后的 nodes；直接绘制 WebGL 或 Canvas 的代码须消费这些对象属性，编辑器无法自动改写任意绘图算法。未声明对象的 WebGL 场景仍可编辑公开参数与源代码。
- 组件实例配置来自代码中的稳定实例 ID；当前通过实例参数和对象覆盖分别调整，新增实例由代码实现。
- 本轮关键帧编辑位于属性面板；尚未提供程序对象的贝塞尔曲线图或批量关键帧操作。
- 连续模拟状态快照、SDK 粒子系统、专用 Three.js 适配器属于第四轮；DOM/React 场景、跨工程引用和自动合并仍待后续阶段。
