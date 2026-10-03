import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AiSession, EditorAiRequest } from '../shared/ai-service';
import { BookOpen, Box, Check, ChevronDown, Circle, ClipboardCheck, Code2, Copy, Eye, EyeOff, Expand, FileImage, Film, FolderOpen, Image, Layers, LockKeyhole, Music2, Pause, Play, Plus, Redo2, RotateCcw, Save, Search, Settings2, Shapes, Trash2, Type, Undo2, UnlockKeyhole } from 'lucide-react';
import type { EasingCurve, ExportKind, ExportOptions, HistoryEntry, KeyframeValue, Layer, LoadedProject, ProjectCheck, RenderCommand, RenderResult, Scene } from '../shared/types';
import { clipBounds, globalFrameFor, makeLayer, retimeLayer, sceneAtFrame, sceneStartFrame, totalFrames, valueAt } from '../shared/animation';
import { audioFits, duplicateScene, reorderScene, splitScene, trimScene } from '../shared/timeline';
import type { AudioClip } from '../shared/types';
import { SequenceTimeline } from './SequenceTimeline';
import { validateExpression } from '../shared/expression';
import { applyAnimationPreset, type AnimationPreset } from '../shared/presets';
import { enablePrograms } from '../shared/program';
import { programTemplate } from '../shared/program-template';
import { ProgramInspector } from './ProgramInspector';
import { ProgramOverlay, type ProgramOverlayHandle } from './ProgramOverlay';
import { setObjectValues } from './program-edit';
import { pointInPolygon, type ProgramFeedback } from '../sdk';

type AniWebview = HTMLElement & { send: (channel: string, command: RenderCommand) => void; getWebContentsId: () => number };
type DragState = { original: LoadedProject; layerId: string; layerIds: string[]; mode: 'move' | 'scale' | 'rotate'; x: number; y: number; startX: number; startY: number; scaleX: number; scaleY: number; rotation: number; startDistance: number; startAngle: number };
type KeyDragState = { original: LoadedProject; layerId: string; property: string; from: number; to: number; rect: DOMRect };
type TimeDragState = { original: LoadedProject; layerId: string; mode: 'move' | 'start' | 'end'; startX: number; rect: DOMRect; delta: number; changed: boolean };
type CurveTarget = { layerId: string; property: string; frame: number };
type CurveDragState = { original: LoadedProject; target: CurveTarget; handle: 0 | 1; changed: boolean };
const animatedProperties = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'];
const curvePresets: Record<string, EasingCurve> = { linear: [0, 0, 1, 1], easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1] };
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
function fadedVolume(volume: number, position: number, duration: number, fadeIn = 0, fadeOut = 0): number {
  const inGain = fadeIn > 0 ? Math.min(1, position / fadeIn) : 1;
  const outGain = fadeOut > 0 ? Math.min(1, Math.max(0, duration - 1 - position) / fadeOut) : 1;
  return clamp01(volume * inGain * outGain);
}
const newScriptTemplate = `export function render({ ctx, gl, width, height, timeSeconds }) {
  if (ctx) {
    ctx.fillStyle = '#55d5c6';
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.2, 0, Math.PI * 2);
    ctx.fill();
  } else if (gl) {
    gl.clearColor(0.1, 0.6, 0.6, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
`;

function clone(project: LoadedProject): LoadedProject { return structuredClone(project); }
function readFrameValue(layer: Layer, property: string, frame: number, fps = 30): KeyframeValue | boolean | undefined {
  let value: KeyframeValue | boolean | undefined;
  try { value = valueAt(layer, property, frame, fps); }
  catch { value = valueAt({ ...layer, expressions: undefined }, property, frame, fps); }
  return value ?? ({ blur: 0, brightness: 1, saturation: 1, volume: 1, modelScale: 1, modelYaw: 0, modelPitch: 0, modelRoll: 0, cameraDistance: 3, cameraFov: 45, lightIntensity: 2 } as Record<string, number>)[property];
}
function timecode(frame: number, fps: number): string {
  const seconds = Math.floor(frame / fps);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}:${String(frame % fps).padStart(2, '0')}`;
}
function iconFor(layer: Layer) {
  if (layer.type === 'text') return <Type size={15} />;
  if (layer.type === 'shape') return <Shapes size={15} />;
  if (layer.type === 'image' || layer.type === 'svg') return <Image size={15} />;
  if (layer.type === 'video') return <Film size={15} />;
  if (layer.type === 'audio') return <Music2 size={15} />;
  if (layer.type === 'model3d') return <Box size={15} />;
  return <Code2 size={15} />;
}
function resourceMatches(layer: Layer, property: 'asset' | 'mask', relative: string): boolean {
  if (property === 'mask') return /\.(png|jpe?g|webp|svg)$/i.test(relative);
  if (layer.type === 'svg') return /\.svg$/i.test(relative);
  if (layer.type === 'video') return /\.(mp4|webm)$/i.test(relative);
  if (layer.type === 'audio') return /\.(mp3|wav|ogg)$/i.test(relative);
  if (layer.type === 'model3d') return /\.(glb|gltf)$/i.test(relative);
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(relative);
}

export function App() {
  const [project, setProject] = useState<LoadedProject>();
  const [preparedProject, setPreparedProject] = useState<{ original: LoadedProject; prepared: LoadedProject }>();
  const aiSessionId = useRef(crypto.randomUUID());
  const aiHandler = useRef<(request: EditorAiRequest) => Promise<AiSession>>(async () => { throw new Error('Editor is loading'); });
  const readValue = (layer: Layer, property: string, atFrame: number) => readFrameValue(layer, property, atFrame, project?.manifest.fps);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<CurveTarget>();
  const [selectedKeys, setSelectedKeys] = useState<CurveTarget[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [timelineMode, setTimelineMode] = useState<'sequence' | 'layers'>('sequence');
  const [playing, setPlaying] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const [renderTick, setRenderTick] = useState(0);
  const [renderErrors, setRenderErrors] = useState<string[]>([]);
  const [status, setStatus] = useState('正在载入示例工程');
  const [busy, setBusy] = useState(false);
  const [ffmpeg, setFfmpeg] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [checkResult, setCheckResult] = useState<ProjectCheck>();
  const [diffResult, setDiffResult] = useState<string[]>();
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>();
  const [showExportSettings, setShowExportSettings] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [resourcePicker, setResourcePicker] = useState<'asset' | 'mask'>();
  const [resourceFiles, setResourceFiles] = useState<string[]>([]);
  const [previewOnly, setPreviewOnly] = useState(false);
  const [scriptEditor, setScriptEditor] = useState<{ path: string; source: string; saved: string; error?: string }>();
  const [expressionProperty, setExpressionProperty] = useState('x');
  const [expressionDraft, setExpressionDraft] = useState('');
  const [presetChoice, setPresetChoice] = useState<AnimationPreset>('scaleIn');
  const [expressionError, setExpressionError] = useState('');
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [showGrid, setShowGrid] = useState(false);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [exportOptions, setExportOptions] = useState<ExportOptions>({ width: 1920, height: 1080, fps: 30 });
  const [exportKind, setExportKind] = useState<Exclude<ExportKind, 'png'>>('mp4');
  const [undo, setUndo] = useState<LoadedProject[]>([]);
  const [redo, setRedo] = useState<LoadedProject[]>([]);
  const [stageSize, setStageSize] = useState({ width: 960, height: 540 });
  const [scenePanelRatio, setScenePanelRatio] = useState(() => {
    const saved = Number(window.localStorage.getItem('ani:scene-panel-ratio'));
    return Number.isFinite(saved) && saved >= 0.15 && saved <= 0.75 ? saved : 0.42;
  });
  const [timelineHeight, setTimelineHeight] = useState(() => {
    const saved = Number(window.localStorage.getItem('ani:timeline-height-v2'));
    return Number.isFinite(saved) && saved >= 200 && saved <= 520 ? saved : 260;
  });
  const [resizingScenes, setResizingScenes] = useState(false);
  const [resizingTimeline, setResizingTimeline] = useState(false);
  const [interactionActive, setInteractionActive] = useState(false);
  const webview = useRef<AniWebview | null>(null);
  const programOverlay = useRef<ProgramOverlayHandle>(null);
  const [programFeedback, setProgramFeedback] = useState<ProgramFeedback>();
  const [selectedProgramId, setSelectedProgramId] = useState<string>();
  const renderRequest = useRef<{ id: string; timer: number; layerId?: string; revisionKey: string } | undefined>(undefined);
  const lastRender = useRef<{ project: LoadedProject; sceneIndex: number; frame: number; generation: number } | undefined>(undefined);
  const timedOutRender = useRef<{ project: LoadedProject; sceneIndex: number; frame: number } | undefined>(undefined);
  const failedLayers = useRef(new Map<string, string>());
  const drag = useRef<DragState | undefined>(undefined);
  const keyDrag = useRef<KeyDragState | undefined>(undefined);
  const timeDrag = useRef<TimeDragState | undefined>(undefined);
  const curveDrag = useRef<CurveDragState | undefined>(undefined);
  const dirtyRef = useRef(false);
  const editVersion = useRef(0);
  const saveInFlight = useRef(false);
  const initialLoad = useRef<Promise<LoadedProject> | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const centerPanelRef = useRef<HTMLElement>(null);
  const leftPanelRef = useRef<HTMLElement>(null);
  const projectSwitcherRef = useRef<HTMLDivElement>(null);
  const sceneResizeActive = useRef(false);
  const timelineResizeActive = useRef(false);
  const audioPlayers = useRef(new Map<string, HTMLAudioElement>());
  const copiedLayer = useRef<Layer | undefined>(undefined);
  const copiedKeyframes = useRef<{ property: string; offset: number; value: KeyframeValue; easing?: EasingCurve }[]>([]);
  const skipKeyClick = useRef(false);

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => window.ani.onAiRequest(request => {
    void aiHandler.current(request).then(value => window.ani.aiReply({ id: request.id, value }), error => window.ani.aiReply({ id: request.id, error: String(error) }));
  }), []);
  useEffect(() => {
    if (!project) return;
    let active = true;
    void window.ani.prepareSources(project).then(prepared => { if (active) setPreparedProject({ original: project, prepared }); }).catch(error => { if (active) setRenderErrors([String(error)]); });
    return () => { active = false; };
  }, [project]);
  useEffect(() => {
    const onFullscreenChange = () => { if (!document.fullscreenElement) setPreviewOnly(false); };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);
  useEffect(() => { window.localStorage.setItem('ani:scene-panel-ratio', String(scenePanelRatio)); }, [scenePanelRatio]);
  useEffect(() => { window.localStorage.setItem('ani:timeline-height-v2', String(timelineHeight)); }, [timelineHeight]);
  useEffect(() => {
    if (!showProjectMenu && !showExportSettings) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Element;
      if (showProjectMenu && !projectSwitcherRef.current?.contains(target)) setShowProjectMenu(false);
      if (showExportSettings && !target.closest('.export-settings, .icon-action')) setShowExportSettings(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [showProjectMenu, showExportSettings]);
  useEffect(() => {
    let active = true;
    initialLoad.current ||= window.ani.sample();
    void initialLoad.current.then(loaded => {
      if (!active) return;
      const firstLayer = loaded.scenes[0]?.layers.find(layer => layer.id === 'intro-title')?.id || loaded.scenes[0]?.layers[0]?.id || '';
      setProject(loaded); setSelectedId(firstLayer); setSelectedIds(firstLayer ? [firstLayer] : []);
      setPlayhead(loaded.manifest.id === 'aiscripter-default-motion' ? 75 : 37); setStatus('示例工程已就绪');
      setExportOptions({ width: loaded.manifest.width, height: loaded.manifest.height, fps: loaded.manifest.fps });
    }).catch(error => { if (active) setStatus(String(error)); });
    void window.ani.recent().then(setRecent);
    void window.ani.ffmpeg().then(setFfmpeg);
    const unsubscribe = window.ani.onExternalChange(() => {
      if (dirtyRef.current) { setExternalChange(true); setStatus('外部修改与本地未保存内容冲突'); }
      else void window.ani.reload().then(loaded => {
        if (!loaded) return;
        if (renderRequest.current) window.clearTimeout(renderRequest.current.timer);
        renderRequest.current = undefined; lastRender.current = undefined; failedLayers.current.clear();
        editVersion.current++;
        setProject(loaded); setPlayhead(0); setSelectedId(loaded.scenes[0]?.layers.at(-1)?.id); setSelectedIds(loaded.scenes[0]?.layers.at(-1) ? [loaded.scenes[0].layers.at(-1)!.id] : []); setSelectedKey(undefined);
        setRuntimeReady(false); setRuntimeGeneration(value => value + 1);
        setStatus('已载入外部修改');
      }).catch(error => setStatus(String(error)));
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  const position = project ? sceneAtFrame(project.scenes, Math.max(0, Math.min(totalFrames(project.scenes) - 1, playhead))) : { sceneIndex: 0, frame: 0 };
  const { sceneIndex, frame } = position;
  const scene = project?.scenes[sceneIndex];
  useEffect(() => { setSelectedProgramId(undefined); setProgramFeedback(undefined); }, [project?.root, scene?.id]);
  const seek = (globalFrame: number) => {
    if (!project?.scenes.length) return;
    setPlaying(false);
    setPlayhead(Math.max(0, Math.min(totalFrames(project.scenes) - 1, globalFrame)));
  };
  const selected = scene?.layers.find(layer => layer.id === selectedId);
  const expressionProperties = selected ? [
    ...animatedProperties,
    ...(selected.type === 'audio' ? ['volume'] : ['blur', 'brightness', 'saturation']),
    ...(selected.type === 'model3d' ? ['modelScale', 'modelYaw', 'modelPitch', 'modelRoll', 'cameraDistance', 'cameraFov', 'lightIntensity'] : []),
    ...Object.entries(selected.params || {}).filter(([, value]) => typeof value === 'number').map(([name]) => `params.${name}`),
  ] : [];
  useEffect(() => {
    if (selected && !expressionProperties.includes(expressionProperty)) {
      setExpressionProperty('x');
      return;
    }
    setExpressionDraft(selected?.expressions?.[expressionProperty] || '');
    setExpressionError('');
  }, [project?.root, selected?.id, selected?.type, selected?.expressions?.[expressionProperty], expressionProperty]);
  const projectName = project?.manifest.name ?? '未打开工程';
  const searchHits = project && searchQuery.trim() ? project.scenes.flatMap((item, index) => {
    const needle = searchQuery.trim().toLocaleLowerCase();
    const hits: { sceneIndex: number; layerId?: string; label: string; detail: string }[] = [];
    if (item.name.toLocaleLowerCase().includes(needle)) hits.push({ sceneIndex: index, label: item.name, detail: '场景' });
    for (const layer of item.layers) {
      const parameter = Object.keys(layer.params || {}).find(name => name.toLocaleLowerCase().includes(needle));
      if (layer.name.toLocaleLowerCase().includes(needle) || parameter) hits.push({ sceneIndex: index, layerId: layer.id, label: layer.name, detail: parameter ? `参数 ${parameter} · ${item.name}` : `图层 · ${item.name}` });
    }
    return hits;
  }).slice(0, 60) : [];
  const selectOnly = (id?: string) => { setSelectedProgramId(undefined); setSelectedId(id); setSelectedIds(id ? [id] : []); };
  const selectProgram = (id?: string) => { setPlaying(false); setSelectedId(undefined); setSelectedIds([]); setSelectedProgramId(id); };
  const selectLayer = (id: string, additive: boolean) => {
    setSelectedKeys([]);
    if (!additive) { selectOnly(id); return; }
    const next = selectedIds.includes(id) ? selectedIds.filter(item => item !== id) : [...selectedIds, id];
    setSelectedIds(next); setSelectedId(next.at(-1));
  };

  const setScenePanelPixels = (pixels: number) => {
    const height = leftPanelRef.current?.clientHeight || 1;
    const clamped = Math.max(250, Math.min(height - 180, pixels));
    setScenePanelRatio(clamped / height);
  };
  const resizeScenePanel = (event: React.PointerEvent) => {
    if (!sceneResizeActive.current || !leftPanelRef.current) return;
    setScenePanelPixels(event.clientY - leftPanelRef.current.getBoundingClientRect().top);
  };
  const stopSceneResize = () => { sceneResizeActive.current = false; setResizingScenes(false); };
  const resizeTimeline = (event: React.PointerEvent) => {
    if (!timelineResizeActive.current || !centerPanelRef.current) return;
    const bounds = centerPanelRef.current.getBoundingClientRect();
    setTimelineHeight(Math.max(200, Math.min(bounds.height - 220, bounds.bottom - event.clientY)));
  };
  const stopTimelineResize = () => { timelineResizeActive.current = false; setResizingTimeline(false); };

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const update = () => {
      const ratio = (project?.manifest.width || 1920) / (project?.manifest.height || 1080);
      const width = zoom === 'fit'
        ? Math.max(1, Math.min(area.clientWidth - 48, (area.clientHeight - 48) * ratio))
        : (project?.manifest.width || 1920) * zoom;
      setStageSize({ width, height: width / ratio });
    };
    const observer = new ResizeObserver(update);
    observer.observe(area); update();
    return () => observer.disconnect();
  }, [project?.manifest.width, project?.manifest.height, zoom]);

  const adopt = useCallback((loaded: LoadedProject) => {
    if (renderRequest.current) window.clearTimeout(renderRequest.current.timer);
    renderRequest.current = undefined; lastRender.current = undefined;
    copiedLayer.current = undefined;
    copiedKeyframes.current = [];
    editVersion.current++;
    dirtyRef.current = false;
    setProject(loaded); setPlayhead(0); setSelectedId(loaded.scenes[0]?.layers.at(-1)?.id); setSelectedIds(loaded.scenes[0]?.layers.at(-1) ? [loaded.scenes[0].layers.at(-1)!.id] : []); setSelectedKey(undefined); setSelectedKeys([]);
    setExportOptions({ width: loaded.manifest.width, height: loaded.manifest.height, fps: loaded.manifest.fps });
    setCheckResult(undefined);
    setDiffResult(undefined); setHistoryEntries(undefined);
    setResourcePicker(undefined);
    void window.ani.recent().then(setRecent);
    setDirty(false); setExternalChange(false); setUndo([]); setRedo([]); setRuntimeReady(false); setRuntimeGeneration(value => value + 1); setRenderErrors([]);
  }, []);

  const commit = useCallback((change: (next: LoadedProject) => void) => {
    if (!project) return;
    const next = clone(project);
    change(next);
    editVersion.current++;
    dirtyRef.current = true;
    setUndo(history => [...history.slice(-49), project]);
    setRedo([]); setProject(next); setDirty(true);
  }, [project]);

  const modifyLayer = useCallback((change: (layer: Layer) => void) => {
    if (!selectedId) return;
    if (project?.scenes[sceneIndex]?.layers.find(item => item.id === selectedId)?.locked) return;
    commit(next => { const layer = next.scenes[sceneIndex].layers.find(item => item.id === selectedId); if (layer) change(layer); });
  }, [commit, project, sceneIndex, selectedId]);

  const applyExpression = () => {
    if (!selected || !expressionProperties.includes(expressionProperty)) return;
    const source = expressionDraft.trim();
    try {
      if (source) {
        validateExpression(source);
        valueAt({ ...selected, expressions: { ...selected.expressions, [expressionProperty]: source } }, expressionProperty, frame, project?.manifest.fps);
      }
      modifyLayer(layer => {
        layer.expressions = { ...layer.expressions };
        if (source) layer.expressions[expressionProperty] = source;
        else delete layer.expressions[expressionProperty];
      });
      setExpressionError('');
    } catch (error) { setExpressionError(String(error)); }
  };

  const updateProperty = useCallback((property: string, value: number | string | boolean) => {
    modifyLayer(layer => {
      if (property.startsWith('params.')) layer.params = { ...layer.params, [property.slice(7)]: value };
      else (layer as unknown as Record<string, unknown>)[property] = value;
      if (layer.keyframes[property]?.length && (typeof value === 'number' || typeof value === 'string')) {
        const keys = layer.keyframes[property];
        const existing = keys.find(key => key.frame === frame);
        if (existing) existing.value = value;
        else keys.push({ frame, value });
      }
    });
  }, [modifyLayer, frame]);
  const updateCrop = (property: 'x' | 'y' | 'width' | 'height', value: number) => {
    modifyLayer(layer => { layer.crop = { x: 0, y: 0, width: 1, height: 1, ...layer.crop, [property]: value }; });
  };

  const toggleKey = useCallback((property: string) => {
    modifyLayer(layer => {
      const keys = layer.keyframes[property] || [];
      const index = keys.findIndex(key => key.frame === frame);
      if (index >= 0) keys.splice(index, 1);
      else {
        const value = readValue(layer, property, frame);
        if (typeof value === 'number' || typeof value === 'string') keys.push({ frame, value });
      }
      layer.keyframes[property] = keys.sort((a, b) => a.frame - b.frame);
    });
  }, [modifyLayer, frame]);

  const open = async () => {
    if (dirty && !confirm('Discard unsaved edits and open another project?')) return;
    try { const loaded = await window.ani.open(); if (loaded) { adopt(loaded); setStatus(`已打开 ${loaded.manifest.name}`); } }
    catch (error) { setStatus(String(error)); }
  };
  const create = async () => {
    if (dirty && !confirm('Discard unsaved edits and create a project?')) return;
    try { const loaded = await window.ani.create(); if (loaded) { adopt(loaded); setStatus(`已新建 ${loaded.manifest.name}`); } }
    catch (error) { setStatus(String(error)); }
  };
  const openFreshSample = async () => {
    if (dirty && !confirm('舍弃未保存的修改并打开新版示例工程？')) return;
    try {
      const loaded = await window.ani.freshSample(); adopt(loaded);
      if (loaded.manifest.id === 'aiscripter-default-motion') { setPlayhead(75); setSelectedId('intro-title'); setSelectedIds(['intro-title']); }
      setStatus('已打开新版示例工程');
    }
    catch (error) { setStatus(String(error)); }
  };
  const openRecent = async (root: string) => {
    if (dirty && !confirm('Discard unsaved edits and open another project?')) return;
    try { const loaded = await window.ani.openRecent(root); adopt(loaded); setStatus(`已打开 ${loaded.manifest.name}`); }
    catch (error) { setStatus(String(error)); }
  };
  const save = async (automatic = false) => {
    if (!project || saveInFlight.current || externalChange) return;
    saveInFlight.current = true;
    const version = editVersion.current;
    try {
      const saved = await window.ani.save(project);
      flushSync(() => {
        if (editVersion.current === version) {
          dirtyRef.current = false;
          setProject(saved); setDirty(false); setExternalChange(false);
        } else setProject(current => current?.root === saved.root ? { ...current, revision: saved.revision } : current);
      });
      setStatus(automatic ? '已自动保存' : '工程已保存');
      return saved;
    } catch (error) {
      if (String(error).includes('EXTERNAL_CHANGE')) setExternalChange(true);
      setStatus(String(error));
    } finally { saveInFlight.current = false; }
  };
  useLayoutEffect(() => {
    aiHandler.current = async request => {
      if (!project) throw new Error('No active project');
      const draftRevision = `${aiSessionId.current}:${editVersion.current}`;
      const state = (value = project): AiSession => ({ mode: 'editor', project: value, draftRevision: `${aiSessionId.current}:${editVersion.current}`, diskRevision: value.revision, dirty: dirtyRef.current, playhead });
      if (request.kind === 'inspect') return state();
      if (request.kind === 'rebase') {
        if (request.project?.root !== project.root) throw new Error('Project session changed');
        const rebased = { ...project, revision: request.project.revision };
        flushSync(() => { editVersion.current++; setProject(rebased); });
        return state(rebased);
      }
      if (draftRevision !== request.expectedDraftRevision) throw new Error('REVISION_CONFLICT: editor draft changed');
      if (busy || saveInFlight.current || externalChange || interactionActive || drag.current || keyDrag.current || timeDrag.current || curveDrag.current || (scriptEditor && scriptEditor.source !== scriptEditor.saved)) throw new Error('EDITOR_BUSY: finish the current edit or resolve the external conflict');
      if (request.kind === 'save') {
        const saved = await save();
        if (!saved) throw new Error('Save failed; inspect diagnostics in the editor');
        return aiHandler.current({ id: request.id, kind: 'inspect' });
      }
      const next = request.project;
      if (!next || next.root !== project.root || next.revision !== project.revision) throw new Error('REVISION_CONFLICT: project changed');
      flushSync(() => {
        editVersion.current++; dirtyRef.current = true;
        setUndo(history => [...history.slice(-49), project]); setRedo([]);
        setProject(next); setDirty(true); setPlaying(false);
        setPlayhead(value => Math.min(value, totalFrames(next.scenes) - 1));
        if (scriptEditor) setScriptEditor({ ...scriptEditor, source: next.sources?.[scriptEditor.path] || '', saved: next.sources?.[scriptEditor.path] || '' });
        setStatus('已应用 AI 修改；可撤销，自动保存使用当前草稿');
      });
      return state(next);
    };
  });
  useEffect(() => {
    if (!project || !dirty || externalChange || busy || interactionActive) return;
    const timer = window.setTimeout(() => { void save(true); }, 2500);
    return () => window.clearTimeout(timer);
  }, [project, dirty, externalChange, busy, interactionActive]);
  const check = async () => {
    if (!project) return;
    try {
      const result = await window.ani.check(project);
      setCheckResult(result);
      setStatus(result.errors.length ? `发现 ${result.errors.length} 个工程错误` : result.warnings.length ? `发现 ${result.warnings.length} 个工程提示` : '工程检查通过');
    } catch (error) { setStatus(String(error)); }
  };
  const compareDisk = async () => {
    if (!project) return;
    try { setDiffResult(await window.ani.diff(project)); }
    catch (error) { setStatus(`比较失败：${String(error)}`); }
  };
  const showHistory = async () => {
    try { setHistoryEntries(await window.ani.history()); }
    catch (error) { setStatus(`读取历史失败：${String(error)}`); }
  };
  const makeSnapshot = async () => {
    if (!project) return;
    if (dirty) { setStatus('请先保存工程，再建立版本快照'); return; }
    try { await window.ani.snapshot(project); await showHistory(); setStatus('已建立完整工程快照'); }
    catch (error) { if (String(error).includes('EXTERNAL_CHANGE')) setExternalChange(true); setStatus(`建立快照失败：${String(error)}`); }
  };
  const restoreSnapshot = async (id: string) => {
    if (!confirm(`恢复 ${new Date(Number(id.slice(0, 13))).toLocaleString()} 的工程版本？当前磁盘版本会先自动备份；未保存的编辑将丢失。`)) return;
    try { const loaded = await window.ani.restore(id); adopt(loaded); setStatus('已恢复工程历史版本'); }
    catch (error) { setStatus(`恢复失败：${String(error)}`); }
  };
  const replaceResource = async (relative: string) => {
    if (!project) return;
    try {
      const revision = await window.ani.replaceResource(project, relative);
      if (!revision) return;
      const updated = { ...project, revision };
      setProject(updated);
      setCheckResult(await window.ani.check(updated));
      setStatus(`已修复资源 ${relative}`);
    } catch (error) { if (String(error).includes('EXTERNAL_CHANGE')) setExternalChange(true); setStatus(`资源修复失败：${String(error)}`); }
  };
  const openResourcePicker = async (property: 'asset' | 'mask') => {
    try { setResourceFiles(await window.ani.listResources()); setResourcePicker(property); }
    catch (error) { setStatus(`读取资源失败：${String(error)}`); }
  };
  const importResources = async () => {
    if (!project || !selected || !resourcePicker) return;
    try {
      const result = await window.ani.importResources(project);
      if (!result?.assets.length) return;
      const next = clone(project);
      next.revision = result.revision;
      const layer = next.scenes[sceneIndex].layers.find(item => item.id === selected.id);
      const chosen = result.assets.find(relative => layer && resourceMatches(layer, resourcePicker, relative));
      if (layer && !layer.locked && chosen) layer[resourcePicker] = chosen;
      editVersion.current++; dirtyRef.current = true;
      setUndo(history => [...history.slice(-49), { ...project, revision: result.revision }]); setRedo([]);
      setProject(next); setDirty(true);
      setResourceFiles(await window.ani.listResources()); setResourcePicker(undefined);
      setStatus(chosen ? `已导入 ${result.assets.length} 个工程资源` : '文件已导入；类型与当前图层不匹配，请选择合适资源');
    } catch (error) { if (String(error).includes('EXTERNAL_CHANGE')) setExternalChange(true); setStatus(`导入资源失败：${String(error)}`); }
  };
  const saveCopy = async () => {
    if (!project) return;
    try { const saved = await window.ani.saveCopy(project); if (saved) { adopt(saved); setStatus(`副本已保存至 ${saved.root}`); } }
    catch (error) { setStatus(String(error)); }
  };
  const reload = async () => {
    try { const loaded = await window.ani.reload(); if (loaded) { adopt(loaded); setStatus('工程已重新载入'); } }
    catch (error) { setStatus(String(error)); }
  };
  const exportFile = async (kind: ExportKind) => {
    if (!project) return;
    setBusy(true); setStatus(kind === 'png' ? '正在渲染单帧…' : '正在渲染动画…');
    try { const output = await window.ani.export(project, kind, sceneIndex, frame, exportOptions); setStatus(output ? `已导出 ${output}` : '已取消导出'); }
    catch (error) { setStatus(`导出失败：${String(error)}`); }
    finally { setBusy(false); }
  };
  const openScriptEditor = async (relative = selected?.script) => {
    if (!relative) return;
    try {
      const source = project?.sources?.[relative] ?? await window.ani.readScript(relative);
      setScriptEditor({ path: relative, source, saved: source });
    } catch (error) {
      if (String(error).includes('ENOENT')) setScriptEditor({ path: relative, source: newScriptTemplate, saved: '' });
      else setStatus(`脚本读取失败：${String(error)}`);
    }
  };
  const saveScript = async () => {
    if (!scriptEditor || !project) return;
    try {
      if (selected?.locked) throw new Error('图层已锁定');
      commit(next => { (next.sources ||= {})[scriptEditor.path] = scriptEditor.source; });
      setScriptEditor(current => current ? { ...current, saved: current.source, error: undefined } : current);
      lastRender.current = undefined;
      setRuntimeReady(false);
      setRuntimeGeneration(value => value + 1);
      setStatus(`脚本已应用到工程草稿：${scriptEditor.path}`);
    } catch (error) {
      setScriptEditor(current => current ? { ...current, error: String(error) } : current);
      if (String(error).includes('EXTERNAL_CHANGE')) setExternalChange(true);
    }
  };
  const closeScriptEditor = () => {
    if (scriptEditor?.source !== scriptEditor?.saved && !confirm('脚本有未保存的修改，确定关闭吗？')) return;
    setScriptEditor(undefined);
  };
  useEffect(() => {
    setScriptEditor(current => {
      if (!current || current.source !== current.saved) return current;
      const source = project?.sources?.[current.path];
      return source !== undefined && source !== current.saved ? { ...current, source, saved: source } : current;
    });
  }, [project?.sources]);

  useEffect(() => {
    const element = webview.current;
    if (!element || !project) return;
    const ready = () => setRuntimeReady(true);
    const message = (event: Event) => {
      const detail = event as Event & { channel?: string; args?: (RenderResult | { requestId: string; layerId: string })[] };
      if (detail.channel === 'runtime:progress' && detail.args?.[0]) {
        const progress = detail.args[0] as { requestId: string; layerId: string };
        if (renderRequest.current?.id === progress.requestId) renderRequest.current.layerId = progress.layerId;
      }
      if (detail.channel === 'runtime:result' && detail.args?.[0]) {
        const result = detail.args[0] as RenderResult;
        if (renderRequest.current?.id !== result.requestId) return;
        window.clearTimeout(renderRequest.current.timer);
        renderRequest.current = undefined;
        setRenderErrors(result.errors || (result.error ? [result.error] : []));
        setProgramFeedback(result.programEdit);
        setRenderTick(value => value + 1);
      }
    };
    element.addEventListener('dom-ready', ready);
    element.addEventListener('ipc-message', message);
    return () => { element.removeEventListener('dom-ready', ready); element.removeEventListener('ipc-message', message); };
  }, [project?.root, runtimeGeneration]);

  useEffect(() => {
    if (!runtimeReady || !project || preparedProject?.original !== project || !webview.current) return;
    const revisionKey = JSON.stringify([preparedProject.prepared.resourcePrefix, scene?.id, scene?.program, scene?.durationFrames, project.manifest.width, project.manifest.height, project.manifest.fps]);
    if (renderRequest.current && renderRequest.current.revisionKey !== revisionKey) {
      window.clearTimeout(renderRequest.current.timer);
      renderRequest.current = undefined; lastRender.current = undefined;
    }
    if (renderRequest.current) return;
    if (timedOutRender.current?.project === project && timedOutRender.current.sceneIndex === sceneIndex && timedOutRender.current.frame === frame) return;
    if (lastRender.current?.project === project && lastRender.current.sceneIndex === sceneIndex && lastRender.current.frame === frame && lastRender.current.generation === runtimeGeneration) return;
    const element = webview.current;
    const requestId = crypto.randomUUID();
    const signature = preparedProject.prepared.resourcePrefix;
    const disabledLayerIds = project.scenes[sceneIndex]?.layers.filter(layer => failedLayers.current.get(layer.id) === `${signature}:${layer.script || layer.asset || ''}`).map(layer => layer.id) || [];
    const timer = window.setTimeout(() => {
      if (renderRequest.current?.id !== requestId) return;
      const layerId = renderRequest.current.layerId;
      renderRequest.current = undefined;
      lastRender.current = undefined;
      const failed = project.scenes[sceneIndex]?.layers.find(layer => layer.id === layerId);
      if (failed) failedLayers.current.set(failed.id, `${signature}:${failed.script || failed.asset || ''}`);
      else timedOutRender.current = { project, sceneIndex, frame };
      setPlaying(false); setRuntimeReady(false);
      setRenderErrors([`${failed?.name || 'Script'} timed out; renderer restarted`]);
      void window.ani.resetRuntime(element.getWebContentsId()).catch(error => setStatus(String(error))).finally(() => setRuntimeGeneration(value => value + 1));
    }, 30000);
    renderRequest.current = { id: requestId, timer, revisionKey };
    lastRender.current = { project, sceneIndex, frame, generation: runtimeGeneration };
    element.send('runtime:command', { requestId, project: preparedProject.prepared, sceneIndex, frame, host: 'active', disabledLayerIds });
  }, [runtimeReady, project, preparedProject, sceneIndex, frame, renderTick, runtimeGeneration]);

  useEffect(() => () => { if (renderRequest.current) window.clearTimeout(renderRequest.current.timer); }, []);

  useEffect(() => {
    if (!playing || !project || !scene) return;
    const timer = setInterval(() => setPlayhead(value => {
      if (value + 1 < totalFrames(project.scenes)) return value + 1;
      setPlaying(false); return value;
    }), 1000 / project.manifest.fps);
    return () => clearInterval(timer);
  }, [playing, project]);

  useEffect(() => {
    const players = audioPlayers.current;
    const active = new Set<string>();
    if (playing && project && scene) {
      for (const layer of scene.layers) {
        if (layer.type !== 'audio' || !layer.visible || layer.muted || !layer.asset || frame < layer.startFrame || frame >= layer.endFrame) continue;
        active.add(layer.id);
        const url = `project://active/${layer.asset.split('/').map(encodeURIComponent).join('/')}?revision=${encodeURIComponent(project.revision)}`;
        let player = players.get(layer.id);
        if (!player || player.src !== url) {
          player?.pause();
          player = new Audio(url);
          player.preload = 'auto';
          players.set(layer.id, player);
        }
        player.loop = Boolean(layer.loop);
        const elapsed = (frame - layer.startFrame) / project.manifest.fps;
        const expected = layer.loop && Number.isFinite(player.duration) && player.duration > 0 ? elapsed % player.duration : elapsed;
        if (Math.abs(player.currentTime - expected) > 0.25) player.currentTime = expected;
        player.volume = fadedVolume(Number(readValue(layer, 'volume', frame)), frame - layer.startFrame, layer.endFrame - layer.startFrame, layer.fadeInFrames, layer.fadeOutFrames);
        if (player.paused) void player.play().catch(error => setStatus(`音频预览失败：${String(error)}`));
      }
      for (const track of project.manifest.audioTracks || []) for (const clip of track.clips) {
        if (clip.muted || playhead < clip.startFrame || playhead >= clip.startFrame + clip.durationFrames) continue;
        active.add(clip.id);
        const url = `project://active/${clip.asset.split('/').map(encodeURIComponent).join('/')}?revision=${encodeURIComponent(project.revision)}`;
        let player = players.get(clip.id);
        if (!player || player.src !== url) { player?.pause(); player = new Audio(url); player.preload = 'auto'; players.set(clip.id, player); }
        player.loop = Boolean(clip.loop);
        const elapsed = (clip.sourceInFrame + playhead - clip.startFrame) / project.manifest.fps;
        const expected = clip.loop && Number.isFinite(player.duration) && player.duration > 0 ? elapsed % player.duration : elapsed;
        if (Math.abs(player.currentTime - expected) > 0.25) player.currentTime = expected;
        player.volume = fadedVolume(clip.volume, playhead - clip.startFrame, clip.durationFrames, clip.fadeInFrames, clip.fadeOutFrames);
        if (player.paused) void player.play().catch(error => setStatus(`音频预览失败：${String(error)}`));
      }
    }
    for (const [id, player] of players) if (!active.has(id)) { player.pause(); players.delete(id); }
  }, [playing, project, sceneIndex, frame, playhead]);
  useEffect(() => () => { for (const player of audioPlayers.current.values()) player.pause(); audioPlayers.current.clear(); }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape') { if (scriptEditor) closeScriptEditor(); else { setShowProjectMenu(false); setShowLayerMenu(false); setShowExportSettings(false); setCheckResult(undefined); setSearchOpen(false); setShowDocs(false); } return; }
      if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void (scriptEditor ? saveScript() : save()); }
      if (event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoOnce() : undoOnce(); }
      if (event.ctrlKey && event.key.toLowerCase() === 'c' && timelineMode === 'layers' && selectedKeys.length) { event.preventDefault(); copySelectedKeys(); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'v' && timelineMode === 'layers' && copiedKeyframes.current.length) { event.preventDefault(); pasteSelectedKeys(); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'c' && selected) { event.preventDefault(); copiedLayer.current = structuredClone(selected); setStatus(`已复制图层 ${selected.name}`); }
      if (event.ctrlKey && event.key.toLowerCase() === 'v' && copiedLayer.current && scene) { event.preventDefault(); const layer = { ...structuredClone(copiedLayer.current), id: crypto.randomUUID(), name: `${copiedLayer.current.name} 副本`, x: copiedLayer.current.x + 24, y: copiedLayer.current.y + 24, locked: false }; commit(next => next.scenes[sceneIndex].layers.push(layer)); selectOnly(layer.id); }
      if (event.ctrlKey && event.key.toLowerCase() === 'd' && selected) { event.preventDefault(); const layer = { ...structuredClone(selected), id: crypto.randomUUID(), name: `${selected.name} 副本`, x: selected.x + 24, y: selected.y + 24, locked: false }; commit(next => next.scenes[sceneIndex].layers.push(layer)); selectOnly(layer.id); }
      if (event.code === 'Space') { event.preventDefault(); setPlaying(value => !value); }
      if (!event.ctrlKey && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !target.closest('[role="slider"]')) { event.preventDefault(); seek(playhead + (event.key === 'ArrowRight' ? 1 : -1)); }
      if (event.key === 'Delete' && timelineMode === 'layers' && selectedKeys.length) { event.preventDefault(); deleteSelectedKeys(); return; }
      if (event.key === 'Delete' && timelineMode === 'layers' && selectedIds.length) { event.preventDefault(); commit(next => { next.scenes[sceneIndex].layers = next.scenes[sceneIndex].layers.filter(layer => layer.locked || !selectedIds.includes(layer.id)); }); selectOnly(undefined); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  const undoOnce = () => {
    if (!undo.length || !project) return;
    editVersion.current++; dirtyRef.current = true;
    setRedo(history => [...history, project]); setProject({ ...undo.at(-1)!, revision: project.revision }); setUndo(undo.slice(0, -1)); setDirty(true);
  };
  const redoOnce = () => {
    if (!redo.length || !project) return;
    editVersion.current++; dirtyRef.current = true;
    setUndo(history => [...history, project]); setProject({ ...redo.at(-1)!, revision: project.revision }); setRedo(redo.slice(0, -1)); setDirty(true);
  };

  const addScene = () => {
    if (!project) return;
    const id = crypto.randomUUID();
    commit(next => next.scenes.push({ id, name: `Scene ${next.scenes.length + 1}`, durationFrames: 150, layers: [] }));
    setPlayhead(totalFrames(project.scenes)); selectOnly(undefined); setSelectedKey(undefined);
  };
  const addProgramScene = () => {
    if (!project) return;
    const id = crypto.randomUUID(), entry = `scripts/scene-${id}.ts`;
    commit(next => {
      enablePrograms(next);
      (next.sources ||= {})[entry] = programTemplate;
      next.scenes.push({ id, name: `程序场景 ${next.scenes.length + 1}`, durationFrames: 150, layers: [], program: {
        entry, renderer: '2d', seed: 2026, params: { title: 'Programmable scenes', accent: '#71dfcf' },
      } });
    });
    setPlayhead(totalFrames(project.scenes)); selectOnly(undefined); setSelectedKey(undefined);
    setStatus('已添加 v3 程序场景；首次升级保存将备份原工程');
  };
  const deleteScene = () => {
    if (!project || project.scenes.length <= 1) return;
    const remaining = project.scenes.filter((_, index) => index !== sceneIndex);
    commit(next => { next.scenes = remaining; }); setPlayhead(Math.min(playhead, totalFrames(remaining) - 1)); selectOnly(undefined); setSelectedKey(undefined);
  };
  const moveScene = (offset: number) => {
    const target = sceneIndex + offset;
    if (!project || target < 0 || target >= project.scenes.length) return;
    const reordered = reorderScene(project.scenes, sceneIndex, target);
    commit(next => { next.scenes = reordered; });
    setPlayhead(globalFrameFor(reordered, target, frame));
  };
  const changeSceneDuration = (value: number) => {
    if (!project || !scene || !Number.isInteger(value) || value < 1) return;
    const minimum = Math.max(scene.clip?.outFrame || 1, ...scene.layers.map(layer => Math.max(layer.endFrame, ...Object.values(layer.keyframes).flatMap(keys => keys.map(key => key.frame + 1)))));
    if (value < minimum) { setStatus(`源场景至少需要 ${minimum} 帧；请先调整图层或片段`); return; }
    commit(next => { next.scenes[sceneIndex].durationFrames = value; if (!scene.clip) next.scenes[sceneIndex].clip = { inFrame: 0, outFrame: value }; });
  };
  const duplicateClip = (index: number) => {
    if (!project) return;
    const copy = duplicateScene(project.scenes[index], () => crypto.randomUUID());
    commit(next => { next.scenes.splice(index + 1, 0, copy); });
    setPlayhead(sceneStartFrame(project.scenes, index + 1)); selectOnly(undefined);
  };
  const splitAtPlayhead = () => {
    if (!project) return;
    const split = splitScene(project.scenes, playhead, () => crypto.randomUUID());
    if (split === project.scenes) return;
    commit(next => { next.scenes = split; });
    selectOnly(undefined);
  };
  const reorderClip = (from: number, to: number) => {
    if (!project || from === to) return;
    commit(next => { next.scenes = reorderScene(next.scenes, from, to); });
    selectOnly(undefined);
  };
  const trimClip = (index: number, edge: 'start' | 'end', delta: number) => {
    if (!project || !delta) return;
    const trimmed = trimScene(project.scenes[index], edge, delta);
    if (JSON.stringify(trimmed.clip) === JSON.stringify(project.scenes[index].clip)) return;
    commit(next => { next.scenes[index] = trimmed; });
    const adjusted = [...project.scenes]; adjusted[index] = trimmed;
    setPlayhead(value => Math.min(value, totalFrames(adjusted) - 1));
  };
  const deleteClip = (index: number) => {
    if (!project || project.scenes.length <= 1) return;
    commit(next => { next.scenes.splice(index, 1); });
    setPlayhead(value => Math.min(value, totalFrames(project.scenes.filter((_, item) => item !== index)) - 1)); selectOnly(undefined);
  };
  const addAudioTrack = () => commit(next => { (next.manifest.audioTracks ||= []).push({ id: crypto.randomUUID(), name: `音轨 ${(next.manifest.audioTracks?.length || 0) + 1}`, clips: [] }); });
  const changeAudioClip = (trackIndex: number, clip: AudioClip) => {
    if (!project) return;
    const track = project.manifest.audioTracks?.[trackIndex];
    if (!track || !audioFits(track, clip)) { setStatus('音频片段不能重叠或越过时间轴起点'); return; }
    commit(next => { const found = next.manifest.audioTracks![trackIndex].clips.findIndex(item => item.id === clip.id); if (found >= 0) next.manifest.audioTracks![trackIndex].clips[found] = clip; });
  };
  const deleteAudioClip = (trackIndex: number, id: string) => commit(next => { next.manifest.audioTracks![trackIndex].clips = next.manifest.audioTracks![trackIndex].clips.filter(clip => clip.id !== id); });
  const importAudio = async () => {
    if (!project) return;
    try {
      const imported = await window.ani.importAudio(project);
      if (!imported) return;
      const next = clone(project);
      next.revision = imported.revision;
      next.manifest.audioTracks ||= [];
      if (!next.manifest.audioTracks.length) next.manifest.audioTracks.push({ id: crypto.randomUUID(), name: '音乐', clips: [] });
      const newClip: AudioClip = { id: crypto.randomUUID(), asset: imported.asset, startFrame: playhead, sourceInFrame: 0, durationFrames: imported.durationFrames, volume: 1 };
      const track = next.manifest.audioTracks.find(item => audioFits(item, newClip));
      if (track) track.clips.push(newClip);
      else next.manifest.audioTracks.push({ id: crypto.randomUUID(), name: `音轨 ${next.manifest.audioTracks.length + 1}`, clips: [newClip] });
      editVersion.current++; dirtyRef.current = true;
      setUndo(history => [...history.slice(-49), { ...project, revision: imported.revision }]); setRedo([]); setProject(next); setDirty(true);
      setStatus(`已导入音频 ${imported.asset}`);
    } catch (error) { if (String(error).includes('EXTERNAL_CHANGE')) setExternalChange(true); setStatus(String(error)); }
  };
  const moveKey = (event: React.PointerEvent, layerId: string, property: string, from: number) => {
    if (!project || !scene) return;
    if (scene.layers.find(layer => layer.id === layerId)?.locked) return;
    if (event.shiftKey || event.ctrlKey) return;
    skipKeyClick.current = false;
    event.preventDefault(); event.stopPropagation();
    keyDrag.current = { original: project, layerId, property, from, to: from, rect: event.currentTarget.parentElement!.getBoundingClientRect() };
    setInteractionActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    selectOnly(layerId); setPlayhead(globalFrameFor(project.scenes, sceneIndex, from)); setSelectedKey({ layerId, property, frame: from }); setSelectedKeys([{ layerId, property, frame: from }]);
  };
  const dragKey = (event: React.PointerEvent) => {
    const state = keyDrag.current;
    if (!state || !scene) return;
    const to = Math.max(0, Math.min(scene.durationFrames - 1, Math.round((event.clientX - state.rect.left) / state.rect.width * scene.durationFrames)));
    if (to === state.to) return;
    const next = clone(state.original);
    const layer = next.scenes[sceneIndex].layers.find(item => item.id === state.layerId);
    const keys = layer?.keyframes[state.property];
    if (!keys || keys.some(key => key.frame === to && key.frame !== state.from)) return;
    const key = keys.find(item => item.frame === state.from);
    if (!key) return;
    key.frame = to;
    keys.sort((a, b) => a.frame - b.frame);
    state.to = to;
    editVersion.current++; dirtyRef.current = true;
    setProject(next); setPlayhead(globalFrameFor(next.scenes, sceneIndex, to)); setSelectedKey({ layerId: state.layerId, property: state.property, frame: to }); setSelectedKeys([{ layerId: state.layerId, property: state.property, frame: to }]); setDirty(true);
  };
  const finishKeyDrag = (event: React.PointerEvent) => {
    event.stopPropagation();
    const state = keyDrag.current;
    if (state && state.to !== state.from) {
      setUndo(history => [...history.slice(-49), state.original]); setRedo([]);
      skipKeyClick.current = true;
    }
    keyDrag.current = undefined;
    setInteractionActive(false);
  };
  const copySelectedKeys = () => {
    if (!scene || !selectedKeys.length) return;
    const source = scene.layers.find(layer => layer.id === selectedKeys[0].layerId);
    if (!source) return;
    const first = Math.min(...selectedKeys.map(item => item.frame));
    copiedKeyframes.current = selectedKeys.flatMap(target => {
      if (target.layerId !== source.id) return [];
      const key = source.keyframes[target.property]?.find(item => item.frame === target.frame);
      return key ? [{ property: target.property, offset: target.frame - first, value: key.value, easing: key.easing }] : [];
    });
    setStatus(`已复制 ${copiedKeyframes.current.length} 个关键帧`);
  };
  const pasteSelectedKeys = () => {
    if (!project || !scene || !selected || selected.locked || !copiedKeyframes.current.length) return;
    const entries = copiedKeyframes.current.filter(item => frame + item.offset < scene.durationFrames);
    if (!entries.length) { setStatus('粘贴位置超出场景范围'); return; }
    commit(next => {
      const layer = next.scenes[sceneIndex].layers.find(item => item.id === selected.id)!;
      for (const item of entries) {
        const keys = layer.keyframes[item.property] ||= [];
        const target = frame + item.offset;
        const existing = keys.find(key => key.frame === target);
        if (existing) { existing.value = item.value; existing.easing = item.easing; }
        else keys.push({ frame: target, value: item.value, ...(item.easing ? { easing: item.easing } : {}) });
        keys.sort((a, b) => a.frame - b.frame);
      }
    });
    const targets = entries.map(item => ({ layerId: selected.id, property: item.property, frame: frame + item.offset }));
    setSelectedKeys(targets); setSelectedKey(targets[0]);
    setStatus(`已粘贴 ${entries.length} 个关键帧`);
  };
  const deleteSelectedKeys = () => {
    if (!scene || !selectedKeys.length) return;
    const targets = selectedKeys.filter(target => !scene.layers.find(layer => layer.id === target.layerId)?.locked);
    if (!targets.length) return;
    commit(next => {
      for (const target of targets) {
        const layer = next.scenes[sceneIndex].layers.find(item => item.id === target.layerId);
        if (layer?.keyframes[target.property]) layer.keyframes[target.property] = layer.keyframes[target.property].filter(key => key.frame !== target.frame);
      }
    });
    setSelectedKeys([]); setSelectedKey(undefined);
  };
  const beginTimeDrag = (event: React.PointerEvent, layerId: string, mode: TimeDragState['mode']) => {
    if (!project || !scene) return;
    if (scene.layers.find(layer => layer.id === layerId)?.locked) return;
    event.preventDefault(); event.stopPropagation();
    timeDrag.current = { original: project, layerId, mode, startX: event.clientX, rect: (event.currentTarget as HTMLElement).closest('.track-range')!.getBoundingClientRect(), delta: 0, changed: false };
    setInteractionActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    selectOnly(layerId);
  };
  const dragTime = (event: React.PointerEvent) => {
    event.stopPropagation();
    const state = timeDrag.current;
    if (!state || !scene) return;
    const delta = Math.round((event.clientX - state.startX) / state.rect.width * scene.durationFrames);
    if (delta === state.delta) return;
    state.delta = delta;
    const next = clone(state.original);
    const layer = next.scenes[sceneIndex].layers.find(item => item.id === state.layerId);
    const original = state.original.scenes[sceneIndex].layers.find(item => item.id === state.layerId);
    if (!layer || !original) return;
    retimeLayer(layer, scene.durationFrames, state.mode, delta);
    state.changed = layer.startFrame !== original.startFrame || layer.endFrame !== original.endFrame;
    editVersion.current++; dirtyRef.current = true;
    setProject(next); setDirty(true);
  };
  const finishTimeDrag = (event: React.PointerEvent) => {
    event.stopPropagation();
    const state = timeDrag.current;
    if (state?.changed) { setUndo(history => [...history.slice(-49), state.original]); setRedo([]); }
    timeDrag.current = undefined;
    setInteractionActive(false);
  };
  const setCurve = (target: CurveTarget, easing?: EasingCurve) => {
    if (scene?.layers.find(layer => layer.id === target.layerId)?.locked) return;
    commit(next => {
      const key = next.scenes[sceneIndex].layers.find(layer => layer.id === target.layerId)?.keyframes[target.property]?.find(item => item.frame === target.frame);
      if (key) { if (easing) key.easing = easing; else delete key.easing; }
    });
  };
  const moveCurveHandle = (event: React.PointerEvent) => {
    event.preventDefault(); event.stopPropagation();
    const state = curveDrag.current;
    if (!state) return;
    const rect = (event.currentTarget as SVGCircleElement).ownerSVGElement!.getBoundingClientRect();
    const x = clamp01(((event.clientX - rect.left) / rect.width * 200 - 15) / 170);
    const y = clamp01((105 - (event.clientY - rect.top) / rect.height * 120) / 90);
    const next = clone(state.original);
    const key = next.scenes[sceneIndex].layers.find(layer => layer.id === state.target.layerId)?.keyframes[state.target.property]?.find(item => item.frame === state.target.frame);
    if (!key) return;
    const easing = [...(key.easing || curvePresets.linear)] as EasingCurve;
    easing[state.handle * 2] = Number(x.toFixed(3));
    easing[state.handle * 2 + 1] = Number(y.toFixed(3));
    key.easing = easing;
    state.changed = true;
    editVersion.current++; dirtyRef.current = true;
    setProject(next); setDirty(true);
  };
  const finishCurveDrag = (event: React.PointerEvent) => {
    event.stopPropagation();
    const state = curveDrag.current;
    if (state?.changed) { setUndo(history => [...history.slice(-49), state.original]); setRedo([]); }
    curveDrag.current = undefined;
    setInteractionActive(false);
  };
  const addLayer = (type: Layer['type']) => {
    if (!project || !scene) return;
    const layer = makeLayer(type, scene.durationFrames, project.manifest.width, project.manifest.height);
    commit(next => next.scenes[sceneIndex].layers.push(layer)); selectOnly(layer.id);
  };
  const moveLayer = (id: string, direction: -1 | 1) => {
    if (!scene) return;
    const from = scene.layers.findIndex(layer => layer.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= scene.layers.length || scene.layers[from].locked) return;
    commit(next => {
      const layers = next.scenes[sceneIndex].layers;
      layers.splice(to, 0, layers.splice(from, 1)[0]);
    });
  };
  const alignSelected = (axis: 'x' | 'y', side: 'start' | 'center' | 'end') => {
    if (!scene || selectedIds.length < 2) return;
    const layers = scene.layers.filter(layer => selectedIds.includes(layer.id) && !layer.locked);
    if (layers.length < 2) return;
    const size = (layer: Layer) => (axis === 'x' ? layer.width * Number(readValue(layer, 'scaleX', frame)) : layer.height * Number(readValue(layer, 'scaleY', frame)));
    const edge = (layer: Layer) => Number(readValue(layer, axis, frame)) + (side === 'start' ? -size(layer) / 2 : side === 'end' ? size(layer) / 2 : 0);
    const target = side === 'start' ? Math.min(...layers.map(edge)) : side === 'end' ? Math.max(...layers.map(edge)) : layers.reduce((sum, layer) => sum + edge(layer), 0) / layers.length;
    commit(next => {
      for (const layer of next.scenes[sceneIndex].layers.filter(item => selectedIds.includes(item.id) && !item.locked)) {
        const value = Math.round(target + (side === 'start' ? size(layer) / 2 : side === 'end' ? -size(layer) / 2 : 0));
        (layer as unknown as Record<string, unknown>)[axis] = value;
        if (layer.keyframes[axis]?.length) {
          const key = layer.keyframes[axis].find(item => item.frame === frame);
          if (key) key.value = value; else layer.keyframes[axis].push({ frame, value });
        }
      }
    });
  };

  const pointOnStage = (event: PointerEvent | React.PointerEvent) => {
    const bounds = stageRef.current!.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width * (project?.manifest.width || 1),
      y: (event.clientY - bounds.top) / bounds.height * (project?.manifest.height || 1) };
  };
  const pointerDown = (event: React.PointerEvent) => {
    if (!project || !scene) return;
    const point = pointOnStage(event);
    const hit = [...scene.layers].reverse().find(layer => {
      if (!layer.visible || frame < layer.startFrame || frame >= layer.endFrame) return false;
      const x = Number(readValue(layer, 'x', frame)); const y = Number(readValue(layer, 'y', frame));
      const w = layer.width * Number(readValue(layer, 'scaleX', frame)); const h = layer.height * Number(readValue(layer, 'scaleY', frame));
      return point.x >= x - w / 2 && point.x <= x + w / 2 && point.y >= y - h / 2 && point.y <= y + h / 2;
    });
    if (hit && event.shiftKey) { selectLayer(hit.id, true); return; }
    if (!hit && programFeedback?.sceneId === scene.id && programFeedback.frame === frame) {
      const object = [...programFeedback.nodes].reverse().find(node => node.visible && pointInPolygon(point, node.polygon) && node.clips.every(clip => pointInPolygon(point, clip)));
      if (object) { selectProgram(object.id); setPlaying(false); programOverlay.current?.begin(event, object); return; }
    }
    if (!hit || !selectedIds.includes(hit.id)) selectOnly(hit?.id);
    if (!hit || hit.locked) return;
    const x = Number(readValue(hit, 'x', frame)); const y = Number(readValue(hit, 'y', frame));
    drag.current = { original: project, layerId: hit.id, layerIds: selectedIds.includes(hit.id) ? selectedIds : [hit.id], mode: 'move', x, y, startX: point.x, startY: point.y,
      scaleX: Number(readValue(hit, 'scaleX', frame)), scaleY: Number(readValue(hit, 'scaleY', frame)),
      rotation: Number(readValue(hit, 'rotation', frame)), startDistance: 1, startAngle: 0 };
    setInteractionActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const beginHandle = (event: React.PointerEvent, mode: 'scale' | 'rotate') => {
    if (!project || !selected || selected.locked) return;
    event.preventDefault(); event.stopPropagation();
    const point = pointOnStage(event);
    const x = Number(readValue(selected, 'x', frame)); const y = Number(readValue(selected, 'y', frame));
    drag.current = { original: project, layerId: selected.id, layerIds: [selected.id], mode, x, y, startX: point.x, startY: point.y,
      scaleX: Number(readValue(selected, 'scaleX', frame)), scaleY: Number(readValue(selected, 'scaleY', frame)),
      rotation: Number(readValue(selected, 'rotation', frame)), startDistance: Math.max(1, Math.hypot(point.x - x, point.y - y)),
      startAngle: Math.atan2(point.y - y, point.x - x) };
    setInteractionActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent) => {
    if (!drag.current || !project) return;
    const point = pointOnStage(event); const state = drag.current;
    const next = clone(state.original);
    const layer = next.scenes[sceneIndex].layers.find(item => item.id === state.layerId);
    if (!layer) return;
    const snap = (value: number) => snapToGrid ? Math.round(value / 20) * 20 : Math.round(value);
    const values: [string, number][] = state.mode === 'move' ? [
      ['x', snap(state.x + point.x - state.startX)], ['y', snap(state.y + point.y - state.startY)],
    ] : state.mode === 'scale' ? (() => {
      const ratio = Math.max(0.02, Math.hypot(point.x - state.x, point.y - state.y) / state.startDistance);
      return [['scaleX', Number((state.scaleX * ratio).toFixed(3))], ['scaleY', Number((state.scaleY * ratio).toFixed(3))]];
    })() : [['rotation', Number((state.rotation + (Math.atan2(point.y - state.y, point.x - state.x) - state.startAngle) * 180 / Math.PI).toFixed(2))]];
    for (const targetId of state.layerIds) {
      const target = next.scenes[sceneIndex].layers.find(item => item.id === targetId);
      const original = state.original.scenes[sceneIndex].layers.find(item => item.id === targetId);
      if (!target || !original || target.locked) continue;
      for (const [property, primaryValue] of values) {
        const value = state.mode === 'move' ? snap(Number(readValue(original, property, frame)) + (property === 'x' ? point.x - state.startX : point.y - state.startY)) : primaryValue;
        (target as unknown as Record<string, unknown>)[property] = value;
        if (target.keyframes[property]?.length) {
          const key = target.keyframes[property].find(item => item.frame === frame);
          if (key) key.value = value; else target.keyframes[property].push({ frame, value });
        }
      }
    }
    editVersion.current++; dirtyRef.current = true;
    setProject(next); setDirty(true);
  };
  const pointerUp = () => {
    if (drag.current) {
      const original = drag.current.original;
      drag.current = undefined;
      setUndo(history => [...history.slice(-49), original]);
      setRedo([]);
    }
    setInteractionActive(false);
  };

  const field = (label: string, property: string, step = 1) => {
    if (!selected) return null;
    const value = readValue(selected, property, frame);
    const keyed = selected.keyframes[property]?.some(key => key.frame === frame);
    return <label className="property-row" key={property}>
      <span>{label}</span><input type="number" step={step} value={typeof value === 'number' ? Number(value.toFixed(3)) : 0}
        onChange={event => updateProperty(property, Number(event.target.value))} />
      <button title={keyed ? '移除关键帧' : '添加关键帧'} className={`key-button ${keyed ? 'active' : ''}`} onClick={() => toggleKey(property)}>◆</button>
    </label>;
  };
  const keyButton = (property: string) => <button title={selected?.keyframes[property]?.some(key => key.frame === frame) ? '移除关键帧' : '添加关键帧'} className={`key-button ${selected?.keyframes[property]?.some(key => key.frame === frame) ? 'active' : ''}`} onClick={() => toggleKey(property)}>◆</button>;
  const curveKeys = selectedKey && selected?.id === selectedKey.layerId ? [...(selected.keyframes[selectedKey.property] || [])].sort((a, b) => a.frame - b.frame) : [];
  const curveIndex = curveKeys.findIndex(key => key.frame === selectedKey?.frame);
  const curveKey = curveKeys[curveIndex];
  const nextCurveKey = curveKeys[curveIndex + 1];
  const curveEditable = selectedKey && curveKey && nextCurveKey && typeof curveKey.value === 'number' && typeof nextCurveKey.value === 'number';
  const curve = curveKey?.easing || curvePresets.linear;
  const curvePreset = Object.entries(curvePresets).find(([, preset]) => preset.every((value, index) => Math.abs(value - curve[index]) < 0.001))?.[0] || 'custom';

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><img src="/AIS-icon.png" alt="" /></span><strong>AIScripter <span>for ani</span></strong></div>
      <div className="project-switcher" ref={projectSwitcherRef}>
        <button className="project-trigger" title={project?.root} aria-label="工程菜单" aria-expanded={showProjectMenu} onClick={() => { setShowProjectMenu(value => !value); setShowExportSettings(false); }}><span>{projectName}</span>{dirty ? <i className="dirty-dot" /> : null}<ChevronDown size={15} /></button>
        {showProjectMenu ? <div className="project-popover" role="menu">
          <div className="popover-heading">工程</div>
          <button role="menuitem" onClick={() => { setShowProjectMenu(false); void create(); }}><Plus size={15} />新建工程</button>
          <button role="menuitem" onClick={() => { setShowProjectMenu(false); void open(); }}><FolderOpen size={15} />打开工程</button>
          <button role="menuitem" onClick={() => { setShowProjectMenu(false); void openFreshSample(); }}><Play size={15} />打开新版示例工程</button>
          <button role="menuitem" disabled={!project} onClick={() => { setShowProjectMenu(false); void saveCopy(); }}><Copy size={15} />另存副本</button>
          {recent.length ? <><div className="popover-heading recent-heading">最近工程</div>{recent.slice(0, 5).map(root => <button role="menuitem" className="recent-item" key={root} title={root} onClick={() => { setShowProjectMenu(false); void openRecent(root); }}><FolderOpen size={14} /><span>{root.split(/[\\/]/).at(-1)}</span></button>)}</> : null}
          <div className="popover-heading recent-heading">工具</div>
          <button role="menuitem" disabled={!project} onClick={() => { setShowProjectMenu(false); void check(); }}><ClipboardCheck size={15} />检查工程</button>
          <button role="menuitem" disabled={!project} onClick={() => { setShowProjectMenu(false); void compareDisk(); }}><ClipboardCheck size={15} />对比磁盘版本</button>
          <button role="menuitem" disabled={!project} onClick={() => { setShowProjectMenu(false); void showHistory(); }}><RotateCcw size={15} />历史版本</button>
          <button role="menuitem" disabled={!project} onClick={() => { setShowProjectMenu(false); setSearchOpen(true); }}><Search size={15} />搜索工程</button>
          <button role="menuitem" onClick={() => { setShowProjectMenu(false); setShowDocs(true); }}><BookOpen size={15} />项目文档与 AI 规范</button>
        </div> : null}
      </div>
      <div className="toolbar-group file-actions">
        <button title="新建工程" onClick={() => void create()}><Plus size={17} /><span>新建</span></button>
        <button title="打开工程" onClick={open}><FolderOpen size={17} /><span>打开</span></button>
        <button title="保存工程 (Ctrl+S)" onClick={() => void save()} disabled={!project}><Save size={17} /><span>保存</span></button>
      </div>
      <div className="toolbar-group history-actions">
        <button onClick={undoOnce} disabled={!undo.length} title="撤销 (Ctrl+Z)" aria-label="撤销"><Undo2 size={17} /></button>
        <button onClick={redoOnce} disabled={!redo.length} title="重做 (Ctrl+Shift+Z)" aria-label="重做"><Redo2 size={17} /></button>
      </div>
      <div className="toolbar-spacer" />
      <div className="toolbar-group output-actions">
        <button className="play-button" title="预览 / 暂停 (空格)" onClick={() => setPlaying(value => !value)} disabled={!project}>{playing ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}<span>{playing ? '暂停' : '预览'}</span></button>
        <button title="导出当前帧" onClick={() => void exportFile('png')} disabled={!project || busy}><FileImage size={17} /><span>单帧</span></button>
        <button className="primary" title={`导出 ${exportKind.toUpperCase()}`} onClick={() => void exportFile(exportKind)} disabled={!project || busy}><Film size={17} /><span>导出 {exportKind === 'sequence' ? '图片序列' : exportKind.toUpperCase()}</span></button>
        <button className="icon-action" title="导出设置" aria-label="导出设置" aria-expanded={showExportSettings} onClick={() => { setShowExportSettings(value => !value); setShowProjectMenu(false); }} disabled={!project}><Settings2 size={17} /></button>
      </div>
    </header>
    {showExportSettings ? <div className="export-settings"><strong>导出设置</strong><label>格式<select value={exportKind} onChange={event => setExportKind(event.target.value as Exclude<ExportKind, 'png'>)}><option value="mp4">MP4 (H.264)</option><option value="webm">WebM (VP9)</option><option value="gif">GIF</option><option value="sequence">PNG 图片序列</option></select></label><div className="export-settings-fields"><label>宽度<input type="number" min="1" max="8192" value={exportOptions.width} onChange={event => setExportOptions(value => ({ ...value, width: Number(event.target.value) }))} /></label><label>高度<input type="number" min="1" max="8192" value={exportOptions.height} onChange={event => setExportOptions(value => ({ ...value, height: Number(event.target.value) }))} /></label><label>帧率<input type="number" min="1" max="120" value={exportOptions.fps} onChange={event => setExportOptions(value => ({ ...value, fps: Number(event.target.value) }))} /></label></div><label>范围<select value={exportOptions.scope || 'all'} onChange={event => setExportOptions(value => ({ ...value, scope: event.target.value as ExportOptions['scope'], startFrame: value.startFrame ?? playhead, endFrame: value.endFrame ?? totalFrames(project?.scenes || []) }))}><option value="all">整个工程</option><option value="scene">当前场景</option><option value="range">指定全局帧范围</option></select></label>{exportOptions.scope === 'range' ? <div className="export-settings-fields range-fields"><label>起始帧<input type="number" min="0" value={exportOptions.startFrame ?? 0} onChange={event => setExportOptions(value => ({ ...value, startFrame: Number(event.target.value) }))} /></label><label>结束帧（不含）<input type="number" min="1" max={totalFrames(project?.scenes || [])} value={exportOptions.endFrame ?? totalFrames(project?.scenes || [])} onChange={event => setExportOptions(value => ({ ...value, endFrame: Number(event.target.value) }))} /></label></div> : null}<label>质量<select value={exportOptions.quality || 'standard'} onChange={event => setExportOptions(value => ({ ...value, quality: event.target.value as ExportOptions['quality'] }))}><option value="draft">草稿</option><option value="standard">标准</option><option value="high">高</option></select></label><label className="export-alpha"><input type="checkbox" checked={Boolean(exportOptions.transparentBackground)} onChange={event => setExportOptions(value => ({ ...value, transparentBackground: event.target.checked }))} />透明背景（PNG、序列、WebM）</label><small>MP4 需要偶数宽高。指定范围使用全局帧，结束帧不包含在导出中。</small><button onClick={() => setShowExportSettings(false)}>完成</button></div> : null}
    {checkResult ? <div className="check-panel"><div className="check-panel-heading"><strong>工程检查 · {checkResult.ok ? '结构有效' : '需要修正'}</strong><button onClick={() => setCheckResult(undefined)}>关闭</button></div>{[...checkResult.errors, ...checkResult.warnings].length ? <ul>{[...checkResult.errors, ...checkResult.warnings].map((message, index) => <li key={index}>{message}</li>)}</ul> : <p><Check size={16} />未发现问题</p>}{checkResult.missingAssets.length ? <div className="repair-list"><strong>缺失资源</strong>{checkResult.missingAssets.map(relative => <button key={relative} onClick={() => void replaceResource(relative)} title="选择本机文件并复制到工程对应路径">定位并修复 · {relative}</button>)}</div> : null}</div> : null}
    {diffResult ? <div className="check-panel diff-panel"><div className="check-panel-heading"><strong>当前编辑与磁盘版本的差异</strong><button onClick={() => setDiffResult(undefined)}>关闭</button></div><ul>{diffResult.map((line, index) => <li key={index}>{line}</li>)}</ul></div> : null}
    {historyEntries ? <div className="check-panel history-panel"><div className="check-panel-heading"><strong>历史版本</strong><button onClick={() => setHistoryEntries(undefined)}>关闭</button></div><button className="snapshot-action" onClick={() => void makeSnapshot()}>建立当前工程快照</button>{historyEntries.length ? <ul>{historyEntries.map(entry => <li key={entry.id}><span>{new Date(entry.createdAt).toLocaleString()}</span><button onClick={() => void restoreSnapshot(entry.id)}>恢复</button></li>)}</ul> : <p>尚无快照</p>}</div> : null}
    <div className="workspace">
      <aside className={`left-panel ${resizingScenes ? 'resizing' : ''}`} ref={leftPanelRef}>
        <section className="panel-section scenes-section" style={{ height: `clamp(250px, ${scenePanelRatio * 100}%, calc(100% - 180px))` }}>
          <div className="section-heading"><strong>场景 <em>{project?.scenes.length || 0}</em></strong><div><button title="添加程序场景（v3）" aria-label="添加程序场景" onClick={addProgramScene}><Code2 size={17} /></button><button title="添加场景" aria-label="添加场景" onClick={addScene}><Plus size={17} /></button><button title="删除场景" aria-label="删除场景" onClick={deleteScene}><Trash2 size={15} /></button></div></div>
          <div className="scene-list">{project?.scenes.map((item, index) => <button key={item.id} className={`scene-item ${sceneIndex === index ? 'selected' : ''}`}
            onClick={() => { seek(sceneStartFrame(project.scenes, index)); selectOnly(item.layers.at(-1)?.id); setSelectedKey(undefined); }}>
            <span className="scene-thumb">{String(index + 1).padStart(2, '0')}</span><span className="scene-meta"><strong>{item.name}</strong><small>{((clipBounds(item).outFrame - clipBounds(item).inFrame) / project.manifest.fps).toFixed(1)} 秒 · {item.layers.length} 个图层</small></span>
          </button>)}</div>
          {scene ? <div className="scene-controls"><input aria-label="场景名称" title="场景名称" value={scene.name} onChange={event => commit(next => { next.scenes[sceneIndex].name = event.target.value; })} /><label title="场景持续帧数">帧 <input aria-label="场景帧数" type="number" min="1" value={scene.durationFrames} onChange={event => changeSceneDuration(Number(event.target.value))} /></label><button title="场景上移" aria-label="场景上移" disabled={sceneIndex === 0} onClick={() => moveScene(-1)}>↑</button><button title="场景下移" aria-label="场景下移" disabled={sceneIndex === (project?.scenes.length || 1) - 1} onClick={() => moveScene(1)}>↓</button></div> : null}
        </section>
        <div className="panel-divider" role="separator" aria-label="调整场景与图层区域高度" aria-orientation="horizontal" aria-valuemin={250} aria-valuemax={Math.max(250, (leftPanelRef.current?.clientHeight || 430) - 180)} aria-valuenow={Math.max(250, Math.round(scenePanelRatio * (leftPanelRef.current?.clientHeight || 430)))} tabIndex={0}
          onPointerDown={event => { event.preventDefault(); sceneResizeActive.current = true; setResizingScenes(true); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={resizeScenePanel} onPointerUp={stopSceneResize} onPointerCancel={stopSceneResize} onLostPointerCapture={stopSceneResize}
          onKeyDown={event => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); setScenePanelPixels(scenePanelRatio * (leftPanelRef.current?.clientHeight || 1) + (event.key === 'ArrowDown' ? 20 : -20)); }} />
        <section className="panel-section layers-section">
          <div className="section-heading"><strong>图层 <em>{scene?.layers.length || 0}</em></strong><Layers size={17} /></div>
          {scene?.program ? <button className="program-scene-entry" onClick={() => selectOnly(undefined)}><Code2 size={16} />程序场景 · 参数与代码</button> : null}
          <div className="add-layer">
            <span>添加</span><button title="添加文字" aria-label="添加文字" onClick={() => addLayer('text')}><Type size={16} /></button>
            <button title="添加图形" aria-label="添加图形" onClick={() => addLayer('shape')}><Shapes size={16} /></button>
            <button title="添加图片" aria-label="添加图片" onClick={() => addLayer('image')}><Image size={16} /></button>
            <button title="添加自定义代码" aria-label="添加自定义代码" onClick={() => addLayer('custom')}><Code2 size={16} /></button>
            <button title="添加更多图层" aria-label="添加更多图层" aria-expanded={showLayerMenu} onClick={() => setShowLayerMenu(value => !value)}><Plus size={16} /></button>
            {showLayerMenu ? <div className="layer-type-menu"><button onClick={() => { addLayer('svg'); setShowLayerMenu(false); }}><Image size={15} />SVG 图层</button><button onClick={() => { addLayer('video'); setShowLayerMenu(false); }}><Film size={15} />视频图层</button><button onClick={() => { setShowLayerMenu(false); setTimelineMode('sequence'); void importAudio(); }}><Music2 size={15} />添加全局音频</button><button onClick={() => { addLayer('model3d'); setShowLayerMenu(false); }}><Box size={15} />3D 模型</button></div> : null}
          </div>
          <div className="layer-list">{[...(scene?.layers || [])].reverse().map((layer, reverseIndex) => <div key={layer.id} role="button" tabIndex={0} className={`layer-item ${selectedIds.includes(layer.id) ? 'selected' : ''} ${layer.locked ? 'locked' : ''}`} onClick={event => selectLayer(layer.id, event.shiftKey || event.ctrlKey)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectLayer(layer.id, event.shiftKey || event.ctrlKey); } }}>
            <span className="layer-icon">{iconFor(layer)}</span><span className="layer-name">{layer.name}</span>
            {selectedIds.includes(layer.id) ? <><button className="layer-mini" title="图层上移" aria-label={`${layer.name} 上移`} disabled={reverseIndex === 0 || layer.locked} onClick={event => { event.stopPropagation(); moveLayer(layer.id, 1); }}>↑</button><button className="layer-mini" title="图层下移" aria-label={`${layer.name} 下移`} disabled={reverseIndex === (scene?.layers.length || 0) - 1 || layer.locked} onClick={event => { event.stopPropagation(); moveLayer(layer.id, -1); }}>↓</button></> : null}
            <button className="layer-mini" title={layer.locked ? '解锁图层' : '锁定图层'} aria-label={`${layer.locked ? '解锁' : '锁定'} ${layer.name}`} onClick={event => { event.stopPropagation(); commit(next => { const found = next.scenes[sceneIndex].layers.find(item => item.id === layer.id); if (found) found.locked = !found.locked; }); }}>{layer.locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}</button>
            <button className="layer-mini visibility" title={layer.visible ? '隐藏图层' : '显示图层'} aria-label={`${layer.visible ? '隐藏' : '显示'} ${layer.name}`} disabled={layer.locked} onClick={event => { event.stopPropagation(); commit(next => { const found = next.scenes[sceneIndex].layers.find(item => item.id === layer.id); if (found) found.visible = !found.visible; }); }}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
          </div>)}</div>
        </section>
      </aside>
      <main className={`center-panel ${resizingTimeline ? 'resizing' : ''}`} ref={centerPanelRef}>
        <div className="canvas-toolbar"><span className="canvas-dimensions">画布 · {project?.manifest.width || 1920} × {project?.manifest.height || 1080}</span><span className="canvas-scene">{scene?.name || '未选择场景'}</span><label className="zoom-control">缩放 <select aria-label="画布缩放" value={zoom} onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}><option value="fit">适合窗口</option><option value="0.25">25%</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.5">150%</option></select></label><button className={`canvas-tool ${showGrid ? 'active' : ''}`} onClick={() => setShowGrid(value => !value)} title="显示网格">网格</button><button className={`canvas-tool ${snapToGrid ? 'active' : ''}`} onClick={() => setSnapToGrid(value => !value)} title="移动时吸附到 20 像素网格">吸附</button><button className={`canvas-tool ${showSafeArea ? 'active' : ''}`} onClick={() => setShowSafeArea(value => !value)} title="显示 10% 安全区域">安全区</button><button className="preview-button" title="纯预览并全屏" aria-label="全屏预览" onClick={() => { setPreviewOnly(true); void areaRef.current?.requestFullscreen().catch(error => { setPreviewOnly(false); setStatus(String(error)); }); }}><Expand size={15} /></button></div>
        <div className="canvas-area" ref={areaRef}><div className="stage-frame" ref={stageRef} style={{ width: stageSize.width, height: stageSize.height }}>
          {project ? <webview key={runtimeGeneration} ref={element => { webview.current = element as AniWebview | null; }} src="app://runtime/runtime.html" partition="ani-runtime" /> : null}
          {!previewOnly && (showGrid || showSafeArea) ? <div className={`stage-guides ${showGrid ? 'grid' : ''}`} style={{ backgroundSize: `${20 / (project?.manifest.width || 1920) * 100}% ${20 / (project?.manifest.height || 1080) * 100}%` }}>{showSafeArea ? <span className="safe-frame" /> : null}<span className="center-guide horizontal" /><span className="center-guide vertical" /></div> : null}
          {!previewOnly ? <div className="stage-hitbox" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} /> : null}
          {!previewOnly && project && scene?.program && <ProgramOverlay ref={programOverlay} key={scene.id} width={project.manifest.width} height={project.manifest.height} frame={frame} edits={scene.program.edits || {}} node={programFeedback?.sceneId === scene.id && programFeedback.frame === frame ? programFeedback.nodes.find(node => node.id === selectedProgramId) : undefined} point={pointOnStage} onInteraction={setInteractionActive} onCommit={(node, values) => commit(next => {
            next.manifest.sdkVersion = '1.1.0'; const program = next.scenes[sceneIndex].program!; program.edits = setObjectValues(program.edits || {}, node.id, node.type, values, frame);
          })} />}
          {!previewOnly && project && scene ? scene.layers.filter(layer => selectedIds.includes(layer.id)).map(layer => <div key={layer.id} className="selection-box" style={{ left: `${Number(readValue(layer, 'x', frame)) / project.manifest.width * 100}%`, top: `${Number(readValue(layer, 'y', frame)) / project.manifest.height * 100}%`, width: `${layer.width * Number(readValue(layer, 'scaleX', frame)) / project.manifest.width * 100}%`, height: `${layer.height * Number(readValue(layer, 'scaleY', frame)) / project.manifest.height * 100}%`, transform: `translate(-50%,-50%) rotate(${Number(readValue(layer, 'rotation', frame))}deg)` }}>{selectedId === layer.id ? <><button className="rotate-handle" title="拖动旋转" aria-label="拖动旋转" onPointerDown={event => beginHandle(event, 'rotate')} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} /><button className="scale-handle" title="拖动缩放" aria-label="拖动缩放" onPointerDown={event => beginHandle(event, 'scale')} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} /></> : null}</div>) : null}
        </div></div>
        <div className="timeline-divider" role="separator" aria-label="调整画布与时间轴高度" aria-orientation="horizontal" aria-valuemin={200} aria-valuemax={Math.max(200, (centerPanelRef.current?.clientHeight || 600) - 220)} aria-valuenow={timelineHeight} tabIndex={0}
          onPointerDown={event => { event.preventDefault(); timelineResizeActive.current = true; setResizingTimeline(true); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={resizeTimeline} onPointerUp={stopTimelineResize} onPointerCancel={stopTimelineResize} onLostPointerCapture={stopTimelineResize}
          onKeyDown={event => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); setTimelineHeight(value => Math.max(200, Math.min((centerPanelRef.current?.clientHeight || 740) - 220, value + (event.key === 'ArrowUp' ? 20 : -20)))); }} />
        <div className="timeline" style={{ height: timelineHeight }}>
          <div className="timeline-tabs"><button className={timelineMode === 'sequence' ? 'active' : ''} onClick={() => setTimelineMode('sequence')}>编排</button><button className={timelineMode === 'layers' ? 'active' : ''} onClick={() => setTimelineMode('layers')}>场景图层</button><span>{timecode(playhead, project?.manifest.fps || 30)} / {timecode(totalFrames(project?.scenes || []), project?.manifest.fps || 30)}</span></div>
          {timelineMode === 'sequence' && project ? <SequenceTimeline project={project} playhead={playhead} sceneIndex={sceneIndex} onSeek={seek} onReorder={reorderClip} onTrim={trimClip} onDuplicate={duplicateClip} onSplit={splitAtPlayhead} onDelete={deleteClip} onImportAudio={() => void importAudio()} onAddAudioTrack={addAudioTrack} onAudioChange={changeAudioClip} onAudioDelete={deleteAudioClip} /> : <>
          <div className="timeline-heading"><strong>时间轴</strong><div className="timeline-controls"><button title="返回起始帧" aria-label="返回起始帧" onClick={() => seek(sceneStartFrame(project!.scenes, sceneIndex))}><RotateCcw size={14} /></button><button title={playing ? '暂停' : '播放'} aria-label={playing ? '暂停' : '播放'} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={15} /> : <Play size={15} />}</button><span>{timecode(frame, project?.manifest.fps || 30)}</span></div><span>第 {frame + 1} / {scene?.durationFrames || 0} 帧</span></div>
          {selectedKeys.length ? <div className="key-selection-actions"><span>已选 {selectedKeys.length} 个关键帧</span><button onClick={copySelectedKeys}>复制</button><button onClick={pasteSelectedKeys} disabled={!copiedKeyframes.current.length || !selected || selected.locked}>粘贴到播放头</button><button onClick={deleteSelectedKeys}>删除</button></div> : copiedKeyframes.current.length && selected && !selected.locked ? <div className="key-selection-actions"><span>已复制 {copiedKeyframes.current.length} 个关键帧</span><button onClick={pasteSelectedKeys}>粘贴到播放头</button></div> : null}
          <div className="ruler"><span>轨道</span><div className="ruler-scale">{Array.from({ length: 6 }, (_, index) => <span key={index} style={{ left: `${index * 20}%` }}>{((scene?.durationFrames || 0) / (project?.manifest.fps || 30) * index / 5).toFixed(1)}s</span>)}<input aria-label="播放位置" type="range" min="0" max={Math.max(0, (scene?.durationFrames || 1) - 1)} value={frame} onChange={event => seek(globalFrameFor(project!.scenes, sceneIndex, Number(event.target.value)))} /></div></div>
          <div className="tracks">{[...(scene?.layers || [])].reverse().map(layer => <div className={`track-row ${selectedIds.includes(layer.id) ? 'selected' : ''}`} key={layer.id}>
            <button onClick={event => selectLayer(layer.id, event.shiftKey || event.ctrlKey)}>{iconFor(layer)}<span>{layer.name}</span></button>
            <div className="track-range" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); seek(globalFrameFor(project!.scenes, sceneIndex, Math.min((scene?.durationFrames || 1) - 1, Math.max(0, Math.round((event.clientX - rect.left) / rect.width * (scene?.durationFrames || 1)))))); }}>
              <div className={`track-bar ${layer.type}`} title="拖动图层以移动；拖动两端以裁剪" style={{ left: `${layer.startFrame / (scene?.durationFrames || 1) * 100}%`, width: `${(layer.endFrame - layer.startFrame) / (scene?.durationFrames || 1) * 100}%` }} onPointerDown={event => beginTimeDrag(event, layer.id, 'move')} onPointerMove={dragTime} onPointerUp={finishTimeDrag} onPointerCancel={finishTimeDrag} onClick={event => event.stopPropagation()}>
                <span className="trim-handle start" title="裁剪图层起点" onPointerDown={event => beginTimeDrag(event, layer.id, 'start')} onPointerMove={dragTime} onPointerUp={finishTimeDrag} onPointerCancel={finishTimeDrag} onClick={event => event.stopPropagation()} />
                <span className="trim-handle end" title="裁剪图层终点" onPointerDown={event => beginTimeDrag(event, layer.id, 'end')} onPointerMove={dragTime} onPointerUp={finishTimeDrag} onPointerCancel={finishTimeDrag} onClick={event => event.stopPropagation()} />
              </div>
              {Object.entries(layer.keyframes).flatMap(([property, keys]) => keys.map((key, index) => <span key={`${property}-${index}`} role="button" tabIndex={0} aria-label={`选择第 ${key.frame} 帧的 ${property} 关键帧`} className={`key-diamond ${selectedKeys.some(item => item.layerId === layer.id && item.property === property && item.frame === key.frame) ? 'active' : ''}`} title={`选择或拖动第 ${key.frame} 帧的 ${property} 关键帧；Shift 点击多选`} style={{ left: `${key.frame / (scene?.durationFrames || 1) * 100}%` }} onPointerDown={event => moveKey(event, layer.id, property, key.frame)} onPointerMove={dragKey} onPointerUp={finishKeyDrag} onPointerCancel={finishKeyDrag} onClick={event => { event.stopPropagation(); if (skipKeyClick.current) { skipKeyClick.current = false; return; } const target = { layerId: layer.id, property, frame: key.frame }; selectOnly(layer.id); seek(globalFrameFor(project!.scenes, sceneIndex, key.frame)); setSelectedKey(target); setSelectedKeys(current => event.shiftKey && current.every(item => item.layerId === layer.id) ? current.some(item => item.layerId === layer.id && item.property === property && item.frame === key.frame) ? current.filter(item => item.property !== property || item.frame !== key.frame) : [...current, target] : [target]); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); } }} />))}
              {selectedId === layer.id ? <div className="playhead" style={{ left: `${frame / (scene?.durationFrames || 1) * 100}%` }} /> : null}
            </div>
          </div>)}</div></>}
        </div>
      </main>
      <aside className="inspector">
        <div className="inspector-title"><strong>属性</strong><span>{selected ? ({ text: '文字', shape: '图形', image: '图片', svg: 'SVG', video: '视频', audio: '音频', model3d: '3D 模型', custom: '自定义代码' }[selected.type]) : '未选择图层'}</span></div>
        {selected ? <div className="inspector-scroll">{selected.locked ? <p className="locked-notice">图层已锁定。可在左侧图层列表解锁后编辑。</p> : null}<fieldset className="inspector-fields" disabled={Boolean(selected.locked)}>
          <section><h3>图层</h3><label className="property-row"><span>名称</span><input value={selected.name} onChange={event => updateProperty('name', event.target.value)} /></label>
            <label className="property-row"><span>开始帧</span><input type="number" value={selected.startFrame} onChange={event => updateProperty('startFrame', Number(event.target.value))} /></label>
            <label className="property-row"><span>结束帧</span><input type="number" value={selected.endFrame} onChange={event => updateProperty('endFrame', Number(event.target.value))} /></label>
          </section>
          {curveEditable && selectedKey ? <section className="curve-editor"><h3>缓动 · {selectedKey.property}</h3><p>第 {curveKey.frame} 帧至第 {nextCurveKey.frame} 帧</p><select aria-label="缓动预设" value={curvePreset} onChange={event => setCurve(selectedKey, event.target.value === 'linear' ? undefined : [...curvePresets[event.target.value]] as EasingCurve)}><option value="linear">线性</option><option value="easeIn">缓入</option><option value="easeOut">缓出</option><option value="easeInOut">缓入缓出</option><option value="custom" disabled>自定义</option></select>
            <svg viewBox="0 0 200 120" className="curve-graph" aria-label="Bezier easing curve"><path className="curve-axis" d="M 15 15 V 105 H 185" /><path className="curve-guides" d={`M 15 105 L ${15 + 170 * curve[0]} ${105 - 90 * curve[1]} M 185 15 L ${15 + 170 * curve[2]} ${105 - 90 * curve[3]}`} /><path className="curve-path" d={`M 15 105 C ${15 + 170 * curve[0]} ${105 - 90 * curve[1]}, ${15 + 170 * curve[2]} ${105 - 90 * curve[3]}, 185 15`} />{([0, 1] as const).map(handle => <circle key={handle} className="curve-handle" cx={15 + 170 * curve[handle * 2]} cy={105 - 90 * curve[handle * 2 + 1]} r="7" onPointerDown={event => { event.preventDefault(); curveDrag.current = { original: project!, target: selectedKey, handle, changed: false }; setInteractionActive(true); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={moveCurveHandle} onPointerUp={finishCurveDrag} onPointerCancel={finishCurveDrag} />)}</svg>
            <div className="curve-values">{curve.map((value, index) => <label key={index}>{['X1', 'Y1', 'X2', 'Y2'][index]}<input type="number" min="0" max="1" step="0.01" value={Number(value.toFixed(3))} onChange={event => { const next = [...curve] as EasingCurve; next[index] = clamp01(Number(event.target.value)); setCurve(selectedKey, next); }} /></label>)}</div>
          </section> : null}
          <section><h3>变换</h3>{field('位置 X', 'x')}{field('位置 Y', 'y')}<label className="property-row"><span>宽度</span><input type="number" min="1" value={selected.width} onChange={event => updateProperty('width', Number(event.target.value))} /></label><label className="property-row"><span>高度</span><input type="number" min="1" value={selected.height} onChange={event => updateProperty('height', Number(event.target.value))} /></label>{field('缩放 X', 'scaleX', 0.01)}{field('缩放 Y', 'scaleY', 0.01)}{field('旋转', 'rotation', 0.1)}{field('不透明度', 'opacity', 0.01)}</section>
          {selectedIds.length > 1 ? <section className="align-section"><h3>多选对齐</h3><div><button onClick={() => alignSelected('x', 'start')}>左</button><button onClick={() => alignSelected('x', 'center')}>水平居中</button><button onClick={() => alignSelected('x', 'end')}>右</button><button onClick={() => alignSelected('y', 'start')}>上</button><button onClick={() => alignSelected('y', 'center')}>垂直居中</button><button onClick={() => alignSelected('y', 'end')}>下</button></div></section> : null}
          {selected.type !== 'audio' ? <section className="preset-section"><h3>动画预设</h3><div className="preset-grid">{([['fadeIn', '淡入'], ['fadeOut', '淡出'], ['slideIn', '滑入'], ['popIn', '弹出']] as [AnimationPreset, string][]).map(([preset, label]) => <button key={preset} title="替换对应属性的现有关键帧" onClick={() => modifyLayer(layer => applyAnimationPreset(layer, preset, project?.manifest.fps || 30))}>{label}</button>)}</div><div className="preset-more"><select aria-label="更多动画预设" value={presetChoice} onChange={event => setPresetChoice(event.target.value as AnimationPreset)}><optgroup label="入场"><option value="scaleIn">缩放进入</option><option value="blurIn">模糊进入</option><option value="rotateIn">旋转进入</option></optgroup><optgroup label="出场"><option value="slideOut">滑出</option><option value="scaleOut">缩放退出</option><option value="blurOut">模糊退出</option></optgroup><optgroup label="循环"><option value="float">浮动</option><option value="pulse">脉冲</option><option value="shake">抖动</option><option value="rotate">旋转</option><option value="breathe">呼吸</option></optgroup></select><button onClick={() => modifyLayer(layer => applyAnimationPreset(layer, presetChoice, project?.manifest.fps || 30))}>应用</button></div><small>预设会替换相应属性的现有关键帧，应用后可继续编辑。</small></section> : null}
          {selected.type === 'text' ? <section><h3>文字</h3><label className="stacked">内容<div className="keyed-content"><textarea value={String(readValue(selected, 'text', frame) || '')} onChange={event => updateProperty('text', event.target.value)} />{keyButton('text')}</div></label><label className="property-row"><span>字体</span><input value={selected.fontFamily || 'Arial'} onChange={event => updateProperty('fontFamily', event.target.value)} /></label><label className="property-row"><span>字号</span><input type="number" min="1" value={selected.fontSize || 64} onChange={event => updateProperty('fontSize', Number(event.target.value))} /></label><label className="property-row"><span>字重</span><input type="number" min="100" max="900" step="100" value={selected.fontWeight || 400} onChange={event => updateProperty('fontWeight', Number(event.target.value))} /></label><label className="property-row"><span>行距</span><input type="number" min="0.1" step="0.05" value={selected.lineHeight || 1.2} onChange={event => updateProperty('lineHeight', Number(event.target.value))} /></label><label className="property-row"><span>字间距</span><input type="number" step="0.5" value={selected.letterSpacing || 0} onChange={event => updateProperty('letterSpacing', Number(event.target.value))} /></label><label className="property-row"><span>对齐</span><select value={selected.textAlign || 'center'} onChange={event => updateProperty('textAlign', event.target.value)}><option value="left">左</option><option value="center">居中</option><option value="right">右</option></select></label><label className="property-row"><span>颜色</span><input type="color" value={String(readValue(selected, 'color', frame) || '#ffffff')} onChange={event => updateProperty('color', event.target.value)} />{keyButton('color')}</label><label className="property-row"><span>描边</span><input type="color" value={selected.textStrokeColor || '#000000'} onChange={event => updateProperty('textStrokeColor', event.target.value)} /></label><label className="property-row"><span>描边宽度</span><input type="number" min="0" step="0.5" value={selected.textStrokeWidth || 0} onChange={event => updateProperty('textStrokeWidth', Number(event.target.value))} /></label></section> : null}
          {selected.type === 'shape' ? <section><h3>图形</h3><label className="property-row"><span>类型</span><select value={selected.shape || 'rect'} onChange={event => updateProperty('shape', event.target.value)}><option value="rect">矩形</option><option value="ellipse">椭圆</option><option value="line">线条</option><option value="polygon">多边形</option><option value="path">路径</option></select></label><label className="property-row"><span>颜色</span><input type="color" value={String(readValue(selected, 'color', frame) || '#ffffff')} onChange={event => updateProperty('color', event.target.value)} />{keyButton('color')}</label>{selected.shape === 'polygon' ? <label className="property-row"><span>边数</span><input type="number" min="3" max="64" value={selected.sides || 5} onChange={event => updateProperty('sides', Number(event.target.value))} /></label> : null}{selected.shape === 'path' ? <label className="stacked">SVG 路径数据<input value={selected.pathData || ''} onChange={event => updateProperty('pathData', event.target.value)} /></label> : null}<label className="property-row"><span>描边</span><input type="color" value={selected.strokeColor || '#ffffff'} onChange={event => updateProperty('strokeColor', event.target.value)} /></label><label className="property-row"><span>描边宽度</span><input type="number" min="0" step="0.5" value={selected.strokeWidth || 0} onChange={event => updateProperty('strokeWidth', Number(event.target.value))} /></label>{!selected.shape || selected.shape === 'rect' ? <label className="property-row"><span>圆角</span><input type="number" min="0" value={selected.cornerRadius || 0} onChange={event => updateProperty('cornerRadius', Number(event.target.value))} /></label> : null}</section> : null}
          {['image', 'svg', 'video', 'audio'].includes(selected.type) ? <section><h3>{selected.type === 'audio' ? '音频' : selected.type === 'video' ? '视频' : selected.type === 'svg' ? 'SVG' : '图片'}</h3><label className="stacked">工程内资源路径<input value={selected.asset || ''} onChange={event => updateProperty('asset', event.target.value)} /></label><button className="resource-action" onClick={() => void openResourcePicker('asset')}>浏览或导入资源</button>{selected.type === 'audio' ? <>{field('音量', 'volume', 0.01)}<label className="property-row"><span>淡入帧数</span><input type="number" min="0" value={selected.fadeInFrames || 0} onChange={event => updateProperty('fadeInFrames', Number(event.target.value))} /></label><label className="property-row"><span>淡出帧数</span><input type="number" min="0" value={selected.fadeOutFrames || 0} onChange={event => updateProperty('fadeOutFrames', Number(event.target.value))} /></label><label className="property-row"><span>循环</span><input type="checkbox" checked={Boolean(selected.loop)} onChange={event => updateProperty('loop', event.target.checked)} /></label><label className="property-row"><span>静音</span><input type="checkbox" checked={Boolean(selected.muted)} onChange={event => updateProperty('muted', event.target.checked)} /></label></> : null}</section> : null}
          {['image', 'svg', 'video'].includes(selected.type) ? <section><h3>媒体画面</h3><label className="property-row"><span>适应</span><select value={selected.mediaFit || 'stretch'} onChange={event => updateProperty('mediaFit', event.target.value)}><option value="stretch">拉伸</option><option value="contain">完整显示</option><option value="cover">填满裁切</option></select></label><div className="crop-fields">{(['x', 'y', 'width', 'height'] as const).map(property => <label key={property}>{({ x: '左', y: '上', width: '宽', height: '高' } as const)[property]}<input type="number" min="0" max="1" step="0.01" value={selected.crop?.[property] ?? (property === 'width' || property === 'height' ? 1 : 0)} onChange={event => updateCrop(property, Number(event.target.value))} /></label>)}</div>{selected.type === 'video' ? <><label className="property-row"><span>播放速度</span><input type="number" min="0.01" step="0.1" value={selected.playbackRate || 1} onChange={event => updateProperty('playbackRate', Number(event.target.value))} /></label><label className="property-row"><span>素材入点帧</span><input type="number" min="0" value={selected.mediaInFrame || 0} onChange={event => updateProperty('mediaInFrame', Number(event.target.value))} /></label></> : null}</section> : null}
          {selected.type !== 'audio' ? <section><h3>阴影</h3><label className="property-row"><span>颜色</span><input type="color" value={selected.shadowColor || '#000000'} onChange={event => updateProperty('shadowColor', event.target.value)} /></label><label className="property-row"><span>模糊</span><input type="number" min="0" value={selected.shadowBlur || 0} onChange={event => updateProperty('shadowBlur', Number(event.target.value))} /></label></section> : null}
          {selected.type === 'model3d' ? <section><h3>3D 模型与镜头</h3><label className="stacked">工程内 .glb / .gltf 路径<input value={selected.asset || ''} onChange={event => updateProperty('asset', event.target.value)} /></label><button className="resource-action" onClick={() => void openResourcePicker('asset')}>浏览或导入资源</button>{field('模型缩放', 'modelScale', 0.01)}{field('朝向 Y', 'modelYaw', 0.1)}{field('俯仰 X', 'modelPitch', 0.1)}{field('翻滚 Z', 'modelRoll', 0.1)}{field('镜头距离', 'cameraDistance', 0.01)}{field('视野角', 'cameraFov', 0.1)}{field('光照强度', 'lightIntensity', 0.01)}</section> : null}
          {selected.type === 'custom' ? <section><h3>自定义模块</h3><label className="stacked">工程内脚本路径<input value={selected.script || ''} onChange={event => updateProperty('script', event.target.value)} /></label><label className="property-row"><span>渲染器</span><select value={selected.renderer || '2d'} onChange={event => updateProperty('renderer', event.target.value)}><option value="2d">Canvas 2D</option><option value="webgl2">WebGL2</option></select></label><h3>公开参数</h3>{Object.entries(selected.params || {}).map(([name, value]) => typeof value === 'number' ? field(name, `params.${name}`, 0.01) : typeof value === 'boolean' ? <label key={name} className="property-row"><span>{name}</span><input type="checkbox" checked={value} onChange={event => updateProperty(`params.${name}`, event.target.checked)} /></label> : <label key={name} className="property-row"><span>{name}</span><input value={String(readValue(selected, `params.${name}`, frame) || '')} onChange={event => updateProperty(`params.${name}`, event.target.value)} />{keyButton(`params.${name}`)}</label>)}</section> : null}
          {selected.type === 'custom' ? <section className="script-action"><button onClick={() => void openScriptEditor()}><Code2 size={16} />在软件内编辑脚本</button><small>保存脚本后会自动重新载入预览。</small></section> : null}
          {selected.type !== 'audio' ? <section><h3>合成与效果</h3><label className="property-row"><span>混合</span><select value={selected.blendMode || 'normal'} onChange={event => updateProperty('blendMode', event.target.value)}><option value="normal">正常</option><option value="multiply">正片叠底</option><option value="screen">滤色</option><option value="overlay">叠加</option><option value="darken">变暗</option><option value="lighten">变亮</option><option value="difference">差值</option><option value="add">相加</option></select></label><label className="stacked">遮罩资源路径<input value={selected.mask || ''} placeholder="assets/mask.png" onChange={event => updateProperty('mask', event.target.value)} /></label><button className="resource-action" onClick={() => void openResourcePicker('mask')}>选择遮罩资源</button>{field('模糊', 'blur', 0.1)}{field('亮度', 'brightness', 0.01)}{field('饱和度', 'saturation', 0.01)}</section> : null}
          {selected.bindings && Object.keys(selected.bindings).length ? <section className="binding-section"><h3>工程数据绑定</h3>{Object.entries(selected.bindings).map(([property, binding]) => <div className="binding-row" key={property}><strong>{property}</strong><code title={`${binding.asset} → ${binding.path}`}>{binding.asset} → {binding.path}</code><button onClick={() => modifyLayer(layer => { layer.bindings = { ...layer.bindings }; delete layer.bindings[property]; })}>移除</button></div>)}<small>数据文件变化后，工程会按外部修改规则重新载入。</small></section> : null}
          <section className="expression-editor"><h3>表达式动画</h3><select aria-label="表达式属性" value={expressionProperty} onChange={event => setExpressionProperty(event.target.value)}>{expressionProperties.map(property => <option key={property} value={property}>{property}</option>)}</select><input aria-label="动画表达式" spellCheck={false} placeholder="base + 20 * sin(time * 2 * pi)" value={expressionDraft} onChange={event => { setExpressionDraft(event.target.value); setExpressionError(''); }} onKeyDown={event => { if (event.key === 'Enter') applyExpression(); }} /><div className="expression-footer"><small>变量：frame、time、fps、base、seed；支持常用数学函数与 noise()</small><button disabled={expressionDraft.trim() === (selected.expressions?.[expressionProperty] || '')} onClick={applyExpression}>应用</button></div>{expressionError ? <p className="expression-error">{expressionError}</p> : null}</section>
          <section className="layer-actions"><button onClick={() => { commit(next => { const layers = next.scenes[sceneIndex].layers; const found = layers.find(item => item.id === selected.id); if (found) layers.push({ ...structuredClone(found), id: crypto.randomUUID(), name: `${found.name} 副本`, locked: false }); }); }}><Copy size={15} />复制图层</button><button onClick={() => { commit(next => { next.scenes[sceneIndex].layers = next.scenes[sceneIndex].layers.filter(item => item.locked || !selectedIds.includes(item.id)); }); selectOnly(undefined); }}><Trash2 size={15} />删除</button></section>
        </fieldset></div> : scene?.program ? <ProgramInspector key={scene.id} scene={scene} frame={frame} feedback={programFeedback?.sceneId === scene.id && programFeedback.frame === frame ? programFeedback : undefined} selectedId={selectedProgramId} onSelect={selectProgram} onSeek={local => seek(globalFrameFor(project!.scenes, sceneIndex, local))} sources={Object.keys(project?.sources || {}).sort()} diagnostics={preparedProject?.original === project ? preparedProject?.prepared.programs?.[scene.id]?.diagnostics || [] : []} onChange={program => commit(next => { next.manifest.sdkVersion = '1.1.0'; next.scenes[sceneIndex].program = program; })} onEdit={relative => void openScriptEditor(relative)} onReset={() => { setRuntimeReady(false); setRuntimeGeneration(value => value + 1); }} /> : <div className="empty-inspector">在画布或图层列表中选择图层，编辑其属性与关键帧。</div>}
      </aside>
    </div>
    {externalChange ? <div className="conflict-banner"><strong>检测到外部修改</strong><span>本地还有未保存的内容</span><button onClick={() => void compareDisk()}>查看差异</button><button onClick={() => void reload()}>舍弃并重载</button><button onClick={() => void saveCopy()}>另存本地副本</button></div> : null}
    {searchOpen ? <div className="search-backdrop" role="presentation" onClick={() => setSearchOpen(false)}><div className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索工程" onClick={event => event.stopPropagation()}><div className="search-heading"><Search size={18} /><input autoFocus placeholder="搜索场景、图层或公开参数" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} /><button onClick={() => setSearchOpen(false)}>关闭</button></div><div className="search-results">{searchHits.map((hit, index) => <button key={`${hit.sceneIndex}-${hit.layerId || 'scene'}-${index}`} onClick={() => { seek(sceneStartFrame(project!.scenes, hit.sceneIndex)); selectOnly(hit.layerId); setSearchOpen(false); }}><strong>{hit.label}</strong><small>{hit.detail}</small></button>)}{searchQuery && !searchHits.length ? <p>没有找到匹配项</p> : null}</div></div></div> : null}
    {showDocs ? <div className="search-backdrop" role="presentation" onClick={() => setShowDocs(false)}><div className="search-dialog docs-dialog" role="dialog" aria-modal="true" aria-label="项目文档与 AI 规范" onClick={event => event.stopPropagation()}><div className="search-heading"><BookOpen size={18} /><strong>项目文档与 AI 规范</strong><button onClick={() => setShowDocs(false)}>关闭</button></div><div className="search-results docs-list">{([
      ['index', '项目文档首页', '版本、示例与工程校验入口'],
      ...(project?.manifest.formatVersion === 1 ? [['legacy', 'v1 工程格式', '当前旧工程的字段规范']] : []),
      ['format', 'v2 工程格式', '场景、图层、关键帧、脚本与导出'],
      ['program', 'v3 程序场景与 SDK', 'TypeScript、组件、常驻运行与示例'],
      ['ai', '外部 AI 创作规范', '创建、续改、交付与人工修改保护'],
      ['mcp', '本机 MCP 接入', '供外部 AI 读取文档和检查工程'],
    ] as [Parameters<typeof window.ani.guide>[0], string, string][]).map(([section, label, description]) => <button key={section} onClick={() => { setShowDocs(false); void window.ani.guide(section).then(error => { if (error) setStatus(error); }); }}><strong>{label}</strong><small>{description}</small></button>)}<button onClick={() => { setShowDocs(false); void window.ani.copyAiSpec().then(length => setStatus(`已复制工程规范与 Schema（${length} 字符）`)).catch(error => setStatus(String(error))); }}><strong>复制规范给外部 AI</strong><small>复制创作指南、v1/v2 格式与 Schema</small></button></div></div></div> : null}
    {resourcePicker ? <div className="search-backdrop" role="presentation" onClick={() => setResourcePicker(undefined)}><div className="search-dialog" role="dialog" aria-modal="true" aria-label="工程资源" onClick={event => event.stopPropagation()}><div className="search-heading"><FolderOpen size={18} /><strong>{resourcePicker === 'mask' ? '选择遮罩' : '选择工程资源'}</strong><button onClick={() => setResourcePicker(undefined)}>关闭</button></div><div className="resource-toolbar"><button onClick={() => void importResources()}>从本机导入文件</button></div><div className="search-results">{resourceFiles.filter(relative => selected && resourceMatches(selected, resourcePicker, relative)).map(relative => <button key={relative} onClick={() => { updateProperty(resourcePicker, relative); setResourcePicker(undefined); }}>{relative}</button>)}{!resourceFiles.some(relative => selected && resourceMatches(selected, resourcePicker, relative)) ? <p>工程内暂无匹配当前图层的资源</p> : null}</div></div></div> : null}
    {scriptEditor ? <div className="script-modal-backdrop" role="presentation"><div className="script-modal" role="dialog" aria-modal="true" aria-label="JavaScript 脚本编辑器"><div className="script-modal-heading"><div><strong>JavaScript 脚本</strong><span>{scriptEditor.path}</span></div><button onClick={closeScriptEditor} aria-label="关闭脚本编辑器">×</button></div><textarea spellCheck={false} aria-label="JavaScript 源代码" value={scriptEditor.source} onChange={event => setScriptEditor(current => current ? { ...current, source: event.target.value, error: undefined } : current)} /><div className="script-modal-footer"><span className={scriptEditor.error ? 'error' : ''}>{scriptEditor.error || (scriptEditor.source === scriptEditor.saved ? '已保存' : '有未保存的脚本修改')}</span><button onClick={closeScriptEditor}>关闭</button><button className="primary" onClick={() => void saveScript()} disabled={scriptEditor.source === scriptEditor.saved}>保存脚本</button></div></div></div> : null}
    <footer className="statusbar"><span>{scene?.name || '未选择场景'}</span><span>{project?.manifest.width || 0} × {project?.manifest.height || 0}</span><span>{project?.manifest.fps || 0} fps</span><span>{ffmpeg ? 'FFmpeg 就绪' : 'FFmpeg 不可用'}</span><span className="status-message">{renderErrors.length ? renderErrors[0] : status}</span><span className={`save-state ${dirty ? 'unsaved' : ''}`}><Circle size={9} fill="currentColor" />{dirty ? '未保存' : '已保存'}</span></footer>
  </div>;
}
