# AIScripter project format version 1

This is the legacy contract for projects that still have `formatVersion: 1`. New projects use [version 2](project-format-v2.md). The v1 manifest schema is `schema/project-v1.schema.json`; the current `schema/scene.schema.json` also describes v2 clip ranges.

This contract defines the folder that an external coding agent creates and modifies. The editor reads and saves the same files. Agents should read the current files before changing an existing project, preserve stable IDs and unspecified user edits, and make focused modifications.

## Folder layout

```text
my-animation/
  project.json
  scenes/
    introduction.json
  scripts/
    background.mjs
  assets/
    picture.png
```

`project.json` is the manifest. It declares `formatVersion: 1`, a stable `id`, display `name`, pixel `width` and `height`, integer `fps`, and ordered scene references of the form `{ "id": "introduction", "file": "scenes/introduction.json" }`. A scene JSON file contains matching `id`, `name`, positive `durationFrames`, and an ordered `layers` array. The first layer renders at the back. All time values are integer, scene-local frame numbers. The end frame of a layer is exclusive.

The v1 manifest schema is `schema/project-v1.schema.json`. See `examples/solar-system/` and `examples/engine-showcase/` for full files.

## Layers

Every layer has stable `id`, display `name`, `type`, `startFrame`, `endFrame`, `x`, `y`, positive `width` and `height`, `scaleX`, `scaleY`, `rotation` in degrees, `opacity` in `[0,1]`, `visible`, and `keyframes`. Coordinates are in project pixels; `x,y` refer to the layer center. Layers can be:

- `text`: `text`, `fontSize`, `fontFamily`, `color`; optional `fontWeight`, `lineHeight`, `letterSpacing`, `textAlign` (`left`, `center`, `right`), `textStrokeColor`, and `textStrokeWidth`. Newlines create multiple text lines.
- `shape`: `shape` (`rect`, `ellipse`, `line`, `polygon`, or `path`) and `color`. Optional `sides` controls a regular polygon; `pathData` contains SVG path commands in layer coordinates. `strokeColor`, `strokeWidth`, and `cornerRadius` control outlines and rounded rectangles.
- `image`: `asset`, a project-relative file path such as `assets/earth.svg`.
- `svg`: `asset`, a project-relative `.svg` file.
- `video`: `asset`, a project-relative video file. Its media time starts at the layer's `startFrame` unless `mediaInFrame` is set. `playbackRate` changes visual playback speed.
- `audio`: `asset`, a project-relative audio file, and optional `volume` from 0 to 1. `muted`, `loop`, `fadeInFrames`, and `fadeOutFrames` control playback. It has no visual surface.
- `model3d`: `asset`, a project-relative `.glb` or `.gltf` file. Optional `modelScale`, `modelYaw`, `modelPitch`, `modelRoll`, `cameraDistance`, `cameraFov`, and `lightIntensity` control its view.
- `custom`: `script`, a project-relative `.mjs` path, `renderer` (`2d` or `webgl2`), and a `params` object containing numbers, strings, or booleans.

Visual layers may also set `locked` to prevent editing in the UI, `mask` to a project-relative image path, `blendMode` to `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `difference`, or `add`, and numeric `blur`, `brightness`, and `saturation` effects. `shadowColor` and `shadowBlur` add a layer shadow. Image, SVG, and video layers accept `mediaFit` (`stretch`, `contain`, or `cover`) and an optional normalized crop `{ "x": 0, "y": 0, "width": 1, "height": 1 }`; the crop rectangle must stay within `[0,1]`.

`keyframes` is an object from property name to arrays of `{ "frame": 0, "value": 1 }`. Animated names include `x`, `y`, `scaleX`, `scaleY`, `rotation`, `opacity`, `text`, `color`, `blur`, `brightness`, `saturation`, `volume`, the 3D controls, and `params.<name>`. Numeric values interpolate linearly by default; strings use the preceding key's value. A numeric keyframe may include `"easing": [0.42, 0, 0.58, 1]`, a cubic Bezier curve for the segment from that key to the next key. The four values are X1, Y1, X2, Y2 in the range `[0,1]`. String keyframes ignore easing. A keyframe must be within its scene's duration. Keep IDs stable when editing an existing object; create new IDs for new objects.

`expressions` maps numeric property names to short math formulas, for example `"expressions": { "x": "base + 20 * sin(time * 2 * pi)" }`. `base` is the property's keyframed value at that frame. Other variables are `frame`, `time` (seconds), `fps`, `seed`, and `pi`. Supported functions are `sin`, `cos`, `tan`, `abs`, `sqrt`, `floor`, `ceil`, `round`, `min`, `max`, `clamp`, `lerp`, and deterministic `noise`. Expressions are parsed as math; JavaScript and property access are not permitted. An expression replaces the property's final value for that frame. A formula that evaluates to a non-finite number causes a layer error on that frame.

`bindings` can read primitive values from a project-local JSON file, for example `"bindings": { "color": { "asset": "assets/data.json", "path": "theme.titleColor" } }`. A path consists of dot-separated JSON object keys. Bindings support `text`, `color`, visual filters, 3D view controls, and existing `params.<name>` values. The JSON value must match the property's type. Bound values provide the base property value; keyframes and expressions can override it at a given frame. Data files are read from the project with a 1 MB size limit. Geometry transforms and audio volume do not currently support bindings in the editor.

## Custom module API

Custom modules may import other `.mjs` modules inside the project. They may export `setup` and must export `render`:

```js
export async function setup({ readProjectFile }) {
  const bytes = await readProjectFile('assets/settings.json');
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function render({ canvas, ctx, gl, width, height, frame, timeSeconds, params, seed, state }) {
  // Use ctx for renderer "2d" or gl for renderer "webgl2".
  // Draw the complete layer for this exact frame.
}
```

`setup` runs in a fresh worker for each rendered frame and can read project files. The editor supplies a scene-local frame number and `timeSeconds`, public `params`, a fixed `seed`, and the setup result as `state`. `render` should derive output from these inputs so requesting the same frame twice produces the same image. Timer APIs and system randomness are unavailable; `Math.random`, `Date`, and `performance.now` are deterministic for a given layer and frame. The rendering canvas is the layer's declared width and height. The editor clears it before each call and composites the result using the layer transform and opacity. A worker that fails or exceeds the per-layer frame limit is terminated without discarding the project.

The script runs without Node.js, shell access, filesystem writes, or network access. Paths containing traversal components and symlinks leading outside the project are rejected. Any assets or helper modules required by the animation belong in the project folder.

## Editing and compatibility

An external agent should modify only the named objects or files. It must keep existing user adjustments, IDs, and supported schema fields unless asked to change them. The editor watches project files and reloads a valid external revision when it has no unsaved local changes. With unsaved edits, it prompts the user instead of merging automatically.

Missing resources or failing custom scripts are shown as layer errors while the rest of the project remains editable. GLB/glTF rendering uses a WebGL2 context; model or video formats must be supported by the bundled Chromium build. Audio export mixes audio layers into MP4 as AAC. Audio `volume` keyframes and expressions affect preview playback and are sampled across visible frames for video export.

Single-frame PNG, PNG sequences, and VP9 WebM can use a transparent background. The editor preview and H.264 MP4 use the normal opaque canvas.
