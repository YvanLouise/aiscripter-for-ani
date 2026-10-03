# AIScripter project format version 2

An external AI agent edits the files in a project folder. Read the current files before changing them, preserve stable IDs and unrelated user edits, and write complete valid JSON. See the [Chinese v2 reference](project-format-v2.zh-CN.md) for a complete current feature summary and the [external AI workflow](external-ai-workflow.zh-CN.md) for creation and revision rules. The detailed layer and script contract also appears in [version 1](project-format-v1.md).

## Files and schemas

```
project.json
scenes/<scene-id>.json
scripts/*.mjs
assets/*
```

`project.json` follows `schema/project.schema.json`. Scene files follow `schema/scene.schema.json`. `examples/sequence-v2/` is a valid two-scene project with one global audio clip. `examples/solar-system/` remains a v1 compatibility example.

## Continuous video track

`project.json.scenes` is an ordered array of `{ "id": "intro", "file": "scenes/intro.json" }`. Each scene has its original `durationFrames`, layers, and scene-local keyframes. Optionally, a scene has `"clip": { "inFrame": 20, "outFrame": 140 }`. The in frame is included and the out frame is excluded. If `clip` is absent, the full `[0, durationFrames)` range plays. `0 <= inFrame < outFrame <= durationFrames` must hold.

The video length is the sum of `outFrame - inFrame` for all scenes. For global frame `g`, find the scene whose cumulative range contains `g`, then render at its local frame `clip.inFrame + (g - cumulativeStart)`. Scene-local audio follows the same mapping. Trimming changes only `clip`; it never deletes hidden layer content or keyframes. The editor copies or splits a scene with fresh scene and layer IDs. Assets and scripts remain shared project resources.

## Global audio tracks

`project.json` may contain `audioTracks`, an array of `{ "id", "name", "clips" }`. An audio clip is:

```json
{
  "id": "music-intro",
  "asset": "assets/music.wav",
  "startFrame": 30,
  "sourceInFrame": 0,
  "durationFrames": 240,
  "volume": 0.8,
  "muted": false
}
```

All frame values are nonnegative integers; duration is positive, and volume is in `[0, 1]`. Audio starts at the absolute project frame `startFrame` and reads the media from `sourceInFrame`. Optional `fadeInFrames` and `fadeOutFrames` apply linear fades; `loop` repeats the source if the clip lasts longer than its media; `muted` suppresses playback. Multiple tracks mix. Clips within one track cannot overlap. Audio does not move when scenes are reordered or trimmed. Audio extending beyond the video end stays in the project but is cut at the video end during export. Audio files must use project-relative paths and remain inside `assets/` in normal projects.

## Editing and export

The editor can lock and reorder layers, browse and import resources, repair missing assets, compare the in-memory project with its current disk version, and save or restore full local snapshots. Manual snapshots are stored in the app's user-data directory rather than in the project folder. The canvas offers grid and safe-area guides, grid snapping, multi-object alignment, project search, and a full-screen preview.

Export can target the complete composition, the current visible scene clip, or a half-open global frame range `[startFrame, endFrame)`. Available formats are H.264 MP4, VP9 WebM, GIF, numbered PNG sequences, and single-frame PNG. PNG, PNG sequences, and WebM can preserve a transparent background. Width, height, output fps, and draft/standard/high encoder quality are adjustable. A different output fps samples the source timeline without altering project time or keyframes.

## v1 migration

The editor opens v1 projects as full-length scene clips. The first save writes v2 and creates `.aiscripter-backups/v1-<timestamp>/project.json` plus the original referenced scene JSON files. Until the first save, source files remain v1. The backup directory is excluded from revision tracking. After upgrade, edit v2 files directly.

The editor watches project files. External agents should update only the requested object and keep other changes. Missing resources produce check warnings while the project remains editable. Invalid JSON, unsafe paths, duplicate IDs, invalid clip ranges, and overlapping audio clips prevent loading or saving.
