# AIScripter 工程格式 v2

适用软件：当前源码版 `0.1.0`。本规范描述**已经实现**的本机工程格式。完整字段边界以 `schema/project.schema.json`、`schema/scene.schema.json` 和编辑器校验逻辑为准。外部 AI 的创建、续改与交付步骤见[创作规范](external-ai-workflow.zh-CN.md)。

## 1. 工程目录与版本

```text
my-animation/
  project.json
  scenes/
    opening.json
  scripts/
    effect.mjs
  assets/
    picture.png
```

`project.json` 是入口。新工程写 `"formatVersion": 2`。清单必须有非空 `id`、`name`，正整数 `width`、`height`（均不超过 8192）、整数 `fps`（1–120）和至少一个 `scenes` 引用。场景引用按播放顺序排列，形式为 `{ "id": "opening", "file": "scenes/opening.json" }`。引用 ID 必须与对应场景 JSON 的 `id` 一致；场景 ID 在工程内不能重复。场景文件名只能采用 `scenes/<字母数字下划线连字符>.json`。

工程内路径一律使用 `/` 分隔的相对路径，例如 `assets/picture.png`、`scripts/effect.mjs`。不接受绝对路径、反斜杠、空路径段、`.`、`..`，也不允许符号链接指向工程外。把所有依赖资源和脚本放在工程目录内。已有 v1 工程可以直接打开；首次保存时转为 v2，并把原始清单与场景 JSON 备份到 `.aiscripter-backups/v1-<时间>/`。

最小清单：

```json
{
  "formatVersion": 2,
  "id": "product-demo",
  "name": "Product Demo",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "scenes": [{ "id": "opening", "file": "scenes/opening.json" }],
  "audioTracks": []
}
```

## 2. 场景、片段与时间

场景文件必须含 `id`、`name`、正整数 `durationFrames` 和 `layers` 数组。`layers` 从前到后按绘制顺序排列：数组首项在画面底层。可选 `clip: { "inFrame": 10, "outFrame": 80 }` 表示只播放局部帧 `[10, 80)`；省略时播放 `[0, durationFrames)`。必须满足 `0 <= inFrame < outFrame <= durationFrames`。裁剪不删除隐藏区间的图层或关键帧，拉回边缘即可恢复。

所有编辑时间都是**整数帧**。场景局部时间的第 0 帧为起点，`outFrame`、图层 `endFrame` 与导出范围结束帧均**不包含**。全局视频帧数等于各场景可见帧数之和。若前一个片段长 35 帧，后一个片段的全局第 35 帧就是其 `clip.inFrame`。场景关键帧、图层时间和旧式场景音频始终使用场景局部帧；全局音轨使用整个工程的绝对帧。重排或裁剪场景不会移动全局音频。

示例场景：

```json
{
  "id": "opening",
  "name": "Opening",
  "durationFrames": 90,
  "clip": { "inFrame": 10, "outFrame": 80 },
  "layers": [
    {
      "id": "title", "name": "Main Title", "type": "text",
      "startFrame": 0, "endFrame": 90,
      "x": 960, "y": 540, "width": 1200, "height": 180,
      "scaleX": 1, "scaleY": 1, "rotation": 0, "opacity": 1,
      "visible": true,
      "keyframes": { "opacity": [{ "frame": 0, "value": 0 }, { "frame": 24, "value": 1 }] },
      "text": "Hello", "fontSize": 90, "fontFamily": "Arial", "color": "#ffffff"
    }
  ]
}
```

## 3. 图层与可编辑性

每个图层都需要稳定的 `id`、`name`、`type`、`startFrame`、`endFrame`、`x`、`y`、正数 `width`、`height`、`scaleX`、`scaleY`、`rotation`、`opacity`、`visible` 和 `keyframes`。同一场景内图层 ID 不重复。`0 <= startFrame < endFrame <= durationFrames`；`rotation` 用角度，`opacity` 为 0–1，`x/y` 是图层中心的工程像素坐标。`locked: true` 可防止软件界面误改该图层，但外部 AI 续改仍须尊重用户锁定意图。

| `type` | 主要字段 | 在编辑器中可直接调整的内容 |
| --- | --- | --- |
| `text` | `text`, `fontSize`, `fontFamily`, `color` | 内容、字体、字重、行距、字间距、对齐、描边、位置和关键帧 |
| `shape` | `shape`, `color` | 矩形、椭圆、线、多边形、SVG 路径数据、描边、圆角 |
| `image` | `asset` | 资源、适应方式、裁切、变换、遮罩和效果 |
| `svg` | `asset`（`.svg`） | 同图片；SVG 内部路径不在属性面板逐点编辑 |
| `video` | `asset` | 画面裁切、适应、素材入点 `mediaInFrame` 和 `playbackRate` |
| `audio` | `asset` | 场景局部音频的音量、淡入淡出、循环与静音；无可见画面 |
| `model3d` | `asset`（`.glb` / `.gltf`） | 模型方向、缩放、镜头距离、视角和光照强度 |
| `custom` | `script`（`scripts/*.mjs`）, `renderer` | 图层变换和公开的 `params`；脚本内画法仍由代码定义 |

普通标题、基础形状和图片应保留为相应原生图层，不要无必要地烘焙成静态图片。复杂效果可放进 `custom`，并把用户会调整的速度、密度、颜色等参数放进 `params`。参数值可为数值、字符串或布尔值；数值与字符串可设置关键帧，布尔值目前作为静态参数。

可选视觉字段：`mask`、`blendMode`（`normal/multiply/screen/overlay/darken/lighten/difference/add`）、`blur`、`brightness`、`saturation`、`shadowColor`、`shadowBlur`。图片、SVG、视频可设置 `mediaFit`（`stretch/contain/cover`）和归一化 `crop: {x,y,width,height}`，裁切框必须位于 `[0,1]` 内。文字可设置 `fontWeight`、`lineHeight`、`letterSpacing`、`textAlign`、`textStrokeColor`、`textStrokeWidth`；图形可设置 `strokeColor`、`strokeWidth`、`cornerRadius`、`sides`、`pathData`。安装在系统中的字体可通过 `fontFamily` 使用；当前没有工程内字体文件的加载契约，交付时应检查目标机器的字体效果。

SVG 素材应在根 `<svg>` 同时声明与 `viewBox` 宽高比一致的 `width` 和 `height`。只写 `viewBox` 时，Chromium 可能使用默认视口，导致画面被裁切。

## 4. 关键帧、表达式与数据绑定

`keyframes` 以属性名为键，值为 `{ "frame": 整数, "value": 数值或字符串 }` 数组。帧须落在场景 `[0, durationFrames)` 内；同一属性的同一帧不能重复。数值默认线性插值，字符串在下一关键帧前保持上一值。数值关键帧可带 `"easing": [x1,y1,x2,y2]`，四项均为 0–1；它控制**此关键帧到下一关键帧**的三次贝塞尔缓动。常用属性包括 `x/y`、缩放、旋转、透明度、文字、颜色、滤镜、场景音量、3D 视图控制和 `params.<参数名>`。编辑器可移动、复制、批量粘贴及删除关键帧。

`expressions` 为数值属性提供逐帧数学式，例如 `"x": "base + 20 * sin(time * 2 * pi)"`。`base` 是当前帧关键帧求值后的值；还可用 `frame`、`time`、`fps`、`seed`、`pi`，及 `sin/cos/tan/abs/sqrt/floor/ceil/round/min/max/clamp/lerp/noise`。表达式不是 JavaScript，不能调用任意对象或读取外部数据。非有限数结果会使该层在该帧报错。

`bindings` 可从工程内不超过 1 MB 的 JSON 读取原始属性值，例如 `"bindings": { "text": { "asset": "assets/data.json", "path": "heading.title" } }`。路径是点分隔的对象键。当前支持 `text`、`color`、视觉滤镜、3D 视图控制与已有 `params.<名称>`；不支持几何变换及音量绑定。绑定值必须与属性类型一致；关键帧和表达式可在给定帧覆盖它。

## 5. 全局音轨

`project.json.audioTracks` 为可选数组。每条音轨有稳定 `id`、`name`、`clips`。音频片段包含 `id`、工程内 `asset`、绝对 `startFrame`、素材 `sourceInFrame`、正整数 `durationFrames`、0–1 的 `volume`，并可设置 `muted`、`loop`、`fadeInFrames`、`fadeOutFrames`。同一音轨内片段不得重叠；不同轨可以混音。超过视频结尾的音频保留在工程里，导出时截断。编辑器中新导入的音频放到全局音轨；原有场景 `audio` 图层仍按场景局部时间播放。

```json
"audioTracks": [{
  "id": "music", "name": "Music",
  "clips": [{
    "id": "music-1", "asset": "assets/music.wav",
    "startFrame": 0, "sourceInFrame": 0,
    "durationFrames": 150, "volume": 0.7,
    "fadeInFrames": 12, "fadeOutFrames": 12
  }]
}]
```

## 6. 自定义 JavaScript / WebGL2

脚本是工程内 `.mjs` 模块，可导入工程内其他模块。`render` 必须导出，`setup` 可选：

```js
export async function setup({ readProjectFile }) {
  const bytes = await readProjectFile('assets/settings.json');
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function render({ canvas, ctx, gl, width, height, frame, timeSeconds, params, seed, state }) {
  if (!ctx) return; // renderer: "webgl2" 时使用 gl
  ctx.fillStyle = String(params.color ?? '#ffffff');
  ctx.fillRect(0, 0, width, height);
}
```

`renderer: "2d"` 提供 Canvas 2D 的 `ctx`；`"webgl2"` 提供 `gl`。每次指定帧都由新 worker 执行 `setup` 和 `render`，输入 `frame` 为场景局部帧，`timeSeconds = frame/fps`。脚本应仅由给定帧、公开参数、固定 `seed` 和工程内只读资源决定画面，重复渲染同一帧要得到同一结果。`Math.random`、`Date` 和 `performance.now` 对给定帧固定；计时器和系统随机数不可用。脚本不能使用 Node.js、系统命令、网络、工程外文件或文件写入。脚本异常和超时只影响该图层。将脚本所需图片或配置放进 `assets/`，通过 `setup.readProjectFile` 读取配置。

## 7. 预览、检查、导出与限制

软件内 **检查工程** 会检查结构、跨文件关系、路径及缺失资源。缺失素材通常是警告，工程仍可打开并修复；格式错误、重复 ID、非法时间范围、路径越界和同轨音频重叠会拒绝加载或保存。外部 AI 可执行 `npm run validate:project -- <工程目录> --strict-assets`，详见[文档首页](README.md)。通过结构检查不代表媒体可解码或视觉效果正确；请在目标机器预览接缝、抽查关键帧，并导出短片段验证。

导出支持当前帧 PNG、H.264 MP4、VP9 WebM、GIF 和编号 PNG 序列。可导出整段、当前可见场景或半开全局帧范围。PNG、PNG 序列与 WebM 可保留透明背景；MP4 为不透明画面，MP4 与 WebM 可混合音频。输出 fps 可不同于工程 fps，导出时按原工程时间采样。MP4、WebM 与 GIF 编码依赖本机 FFmpeg。场景音量关键帧导出会按帧取值，再以约 0.001 的增益容差生成动态音量。视频解码与 3D 效果依赖当前 Chromium 编解码器及 WebGL2。当前没有转场重叠、可复用组件、状态机、多工程引用、工程内字体加载或自动合并冲突的工程契约，不应生成这些字段。
