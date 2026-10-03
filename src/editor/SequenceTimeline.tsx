import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Music2, Plus, Scissors, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import type { AudioClip, LoadedProject, Scene } from '../shared/types';
import { clipBounds, sceneStartFrame, totalFrames } from '../shared/animation';
import { trimAudioClip } from '../shared/timeline';
import { timelineMarkers } from './timeline-ruler';

type Props = {
  project: LoadedProject;
  playhead: number;
  sceneIndex: number;
  onSeek: (frame: number) => void;
  onReorder: (from: number, to: number) => void;
  onTrim: (index: number, edge: 'start' | 'end', delta: number) => void;
  onDuplicate: (index: number) => void;
  onSplit: () => void;
  onDelete: (index: number) => void;
  onImportAudio: () => void;
  onAddAudioTrack: () => void;
  onAudioChange: (track: number, clip: AudioClip) => void;
  onAudioDelete: (track: number, id: string) => void;
};

const Thumbnail = memo(function Thumbnail({ project, scene, index, fraction }: { project: LoadedProject; scene: Scene; index: number; fraction: number }) {
  const [image, setImage] = useState<string>();
  const bounds = clipBounds(scene);
  const frame = Math.min(bounds.outFrame - 1, bounds.inFrame + Math.floor((bounds.outFrame - bounds.inFrame) * fraction));
  useEffect(() => {
    let live = true;
    setImage(undefined);
    void window.ani.thumbnail(project, index, frame).then(data => { if (live) setImage(data); }).catch(() => {});
    return () => { live = false; };
  }, [project.root, project.revision, scene, index, frame]);
  return image ? <span className="sequence-thumbnail-repeat" style={{ backgroundImage: `url("${image}")` }}><img src={image} alt="" draggable={false} /></span> : <span className="sequence-thumb-placeholder" />;
});

const Filmstrip = memo(function Filmstrip({ project, scene, index }: { project: LoadedProject; scene: Scene; index: number }) {
  return <div className="sequence-clip-images">{[0.125, 0.375, 0.625, 0.875].map(fraction => <span className="sequence-thumbnail-cell" key={fraction} style={{ width: '25%' }}><Thumbnail project={project} scene={scene} index={index} fraction={fraction} /></span>)}</div>;
});

const Waveform = memo(function Waveform({ project, clip }: { project: LoadedProject; clip: AudioClip }) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let live = true;
    setImage(undefined);
    void window.ani.waveform(project, clip.asset, 2048, clip.sourceInFrame, clip.durationFrames).then(data => { if (live) setImage(data); }).catch(() => {});
    return () => { live = false; };
  }, [project.root, project.revision, clip.asset, clip.sourceInFrame, clip.durationFrames]);
  return image ? <img src={image} alt="音频波形" draggable={false} /> : <span className="sequence-wave-placeholder">波形不可用</span>;
});

function TimelineRuler({ viewport, fps, pixelsPerFrame, width, ...events }: {
  viewport: React.RefObject<HTMLDivElement | null>; fps: number; pixelsPerFrame: number; width: number;
} & React.HTMLAttributes<HTMLDivElement>) {
  const [visible, setVisible] = useState({ left: 0, width: 800 });
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let scheduled = 0;
    const update = () => {
      scheduled = 0;
      const left = element.scrollLeft;
      const width = element.clientWidth;
      setVisible(current => current.left === left && current.width === width ? current : { left, width });
    };
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(update); };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.addEventListener('scroll', schedule, { passive: true });
    return () => { cancelAnimationFrame(scheduled); observer.disconnect(); element.removeEventListener('scroll', schedule); };
  }, [viewport]);
  const markers = timelineMarkers(fps, pixelsPerFrame, visible.left, visible.width, width);
  return <div className="sequence-ruler" {...events}>{markers.map(marker => <span key={marker.frame} style={{ left: marker.left }}>{marker.label}</span>)}</div>;
}

export function SequenceTimeline(props: Props) {
  const { project, playhead, sceneIndex } = props;
  const [pixelsPerFrame, setPixelsPerFrame] = useState(4);
  const [selectedScene, setSelectedScene] = useState<number>();
  const [selectedAudio, setSelectedAudio] = useState<{ track: number; id: string }>();
  const [volumeDraft, setVolumeDraft] = useState(1);
  const volumeDraftRef = useRef(1);
  const [dragDelta, setDragDelta] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const scale = useRef(pixelsPerFrame);
  const pendingZoom = useRef<{ next: number; frame: number; offsetX: number } | undefined>(undefined);
  const zoomAnimation = useRef(0);
  const zoomAnchor = useRef<{ frame: number; offsetX: number } | undefined>(undefined);
  const panning = useRef<{ pointerId: number; startX: number; scrollLeft: number } | undefined>(undefined);
  const scrubbing = useRef(false);
  const drag = useRef<{ type: 'scene' | 'audio'; index: number; track?: number; clip?: AudioClip; edge?: 'start' | 'end'; startX: number; delta: number } | undefined>(undefined);
  useEffect(() => {
    if (selectedScene !== undefined && selectedScene >= project.scenes.length) setSelectedScene(undefined);
    if (selectedAudio && !project.manifest.audioTracks?.[selectedAudio.track]?.clips.some(clip => clip.id === selectedAudio.id)) setSelectedAudio(undefined);
  }, [project, selectedScene, selectedAudio]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' || ['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) return;
      if (selectedAudio) { event.preventDefault(); props.onAudioDelete(selectedAudio.track, selectedAudio.id); setSelectedAudio(undefined); }
      else if (selectedScene !== undefined) { event.preventDefault(); props.onDelete(selectedScene); setSelectedScene(undefined); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [selectedScene, selectedAudio, props.onAudioDelete, props.onDelete]);
  const length = totalFrames(project.scenes);
  const width = Math.max(800, length * pixelsPerFrame + 200);
  const changeZoom = useCallback((factor: number, clientX?: number) => {
    const viewport = scroll.current;
    if (!viewport) return;
    const previous = pendingZoom.current?.next ?? scale.current;
    const next = Math.max(0.4, Math.min(20, previous * factor));
    if (next === previous) return;
    const offsetX = clientX === undefined ? viewport.clientWidth / 2 : clientX - viewport.getBoundingClientRect().left;
    pendingZoom.current = { next, frame: (viewport.scrollLeft + offsetX) / scale.current, offsetX };
    if (!zoomAnimation.current) zoomAnimation.current = requestAnimationFrame(() => {
      zoomAnimation.current = 0;
      const request = pendingZoom.current;
      pendingZoom.current = undefined;
      if (!request) return;
      zoomAnchor.current = request;
      setPixelsPerFrame(request.next);
    });
  }, []);
  useLayoutEffect(() => {
    scale.current = pixelsPerFrame;
    const anchor = zoomAnchor.current;
    if (anchor && scroll.current) scroll.current.scrollLeft = anchor.frame * pixelsPerFrame - anchor.offsetX;
    zoomAnchor.current = undefined;
  }, [pixelsPerFrame]);
  useEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1);
      changeZoom(Math.pow(1.2, -Math.max(-600, Math.min(600, delta)) / 100), event.clientX);
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => { viewport.removeEventListener('wheel', onWheel); cancelAnimationFrame(zoomAnimation.current); };
  }, [changeZoom]);
  const beginPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    event.preventDefault(); event.stopPropagation();
    panning.current = { pointerId: event.pointerId, startX: event.clientX, scrollLeft: event.currentTarget.scrollLeft };
    event.currentTarget.classList.add('panning');
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panning.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.scrollLeft = pan.scrollLeft + pan.startX - event.clientX;
  };
  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panning.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    panning.current = undefined;
    event.currentTarget.classList.remove('panning');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const snap = (frame: number) => {
    const seams = project.scenes.map((_, i) => sceneStartFrame(project.scenes, i));
    const close = seams.find(value => Math.abs(value - frame) <= Math.max(1, Math.round(8 / pixelsPerFrame)));
    return close ?? frame;
  };
  const pointerFrame = (event: React.PointerEvent): number | undefined => {
    const rect = scroll.current?.querySelector('.sequence-content')?.getBoundingClientRect();
    if (!rect) return undefined;
    return Math.max(0, Math.min(length - 1, Math.round((event.clientX - rect.left) / pixelsPerFrame)));
  };
  const seekAt = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('.sequence-scene-clip, .sequence-audio-clip')) return;
    const frame = pointerFrame(event);
    if (frame !== undefined) props.onSeek(snap(frame));
  };
  const seekWhileDragging = (event: React.PointerEvent) => {
    const frame = pointerFrame(event);
    if (frame !== undefined) props.onSeek(frame);
  };
  const beginScrub = (event: React.PointerEvent) => {
    event.preventDefault(); event.stopPropagation();
    scrubbing.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekWhileDragging(event);
  };
  const scrub = (event: React.PointerEvent) => {
    if (!scrubbing.current) return;
    event.preventDefault(); event.stopPropagation();
    seekWhileDragging(event);
  };
  const endScrub = (event: React.PointerEvent) => {
    if (!scrubbing.current) return;
    event.stopPropagation();
    scrubbing.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const begin = (event: React.PointerEvent, value: NonNullable<typeof drag.current>) => {
    event.preventDefault(); event.stopPropagation();
    drag.current = value;
    setDragDelta(0);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent) => {
    if (!drag.current) return;
    const delta = Math.round((event.clientX - drag.current.startX) / pixelsPerFrame);
    drag.current.delta = delta;
    setDragDelta(delta);
  };
  const end = (event: React.PointerEvent) => {
    const state = drag.current;
    if (!state) return;
    event.stopPropagation();
    drag.current = undefined;
    setDragDelta(0);
    if (!state.delta) {
      if (!state.edge) {
        const rect = event.currentTarget.getBoundingClientRect();
        const local = Math.round((event.clientX - rect.left) / pixelsPerFrame);
        const start = state.type === 'scene' ? sceneStartFrame(project.scenes, state.index) : state.clip!.startFrame;
        props.onSeek(Math.max(0, Math.min(length - 1, start + local)));
      }
      return;
    }
    if (state.type === 'scene') {
      if (state.edge) props.onTrim(state.index, state.edge, state.delta);
      else {
        const start = sceneStartFrame(project.scenes, state.index);
        const center = start + (clipBounds(project.scenes[state.index]).outFrame - clipBounds(project.scenes[state.index]).inFrame) / 2 + state.delta;
        let target = project.scenes.length - 1;
        for (let i = 0; i < project.scenes.length; i++) {
          if (center < sceneStartFrame(project.scenes, i) + (clipBounds(project.scenes[i]).outFrame - clipBounds(project.scenes[i]).inFrame) / 2) { target = i; break; }
        }
        props.onReorder(state.index, target);
        setSelectedScene(target);
      }
    } else if (state.clip && state.track !== undefined) {
      const clip = state.clip;
      const updated = state.edge === 'start'
        ? trimAudioClip(clip, 'start', state.delta)
        : state.edge === 'end'
          ? trimAudioClip(clip, 'end', state.delta)
          : { ...clip, startFrame: Math.max(0, snap(clip.startFrame + state.delta)) };
      if (updated.durationFrames > 0) props.onAudioChange(state.track, updated);
    }
  };
  const activeAudio = selectedAudio && project.manifest.audioTracks?.[selectedAudio.track]?.clips.find(clip => clip.id === selectedAudio.id);
  useEffect(() => { volumeDraftRef.current = activeAudio?.volume ?? 1; setVolumeDraft(volumeDraftRef.current); }, [activeAudio?.id, activeAudio?.volume]);
  const commitVolume = () => {
    if (activeAudio && selectedAudio && volumeDraftRef.current !== activeAudio.volume) props.onAudioChange(selectedAudio.track, { ...activeAudio, volume: volumeDraftRef.current });
  };
  return <div className="sequence-editor">
    <div className="sequence-toolbar">
      <strong>编排时间轴</strong>
      <button title="在播放头处分割场景" onClick={() => { props.onSplit(); setSelectedScene(undefined); }}><Scissors size={14} />分割</button>
      <button title="复制所选片段" disabled={selectedScene === undefined} onClick={() => { props.onDuplicate(selectedScene!); setSelectedScene(selectedScene! + 1); }}><Copy size={14} />复制</button>
      <button title="删除所选片段" disabled={selectedScene === undefined && !selectedAudio} onClick={() => { if (selectedAudio) { props.onAudioDelete(selectedAudio.track, selectedAudio.id); setSelectedAudio(undefined); } else { props.onDelete(selectedScene!); setSelectedScene(undefined); } }}><Trash2 size={14} />删除</button>
      <span className="sequence-spacer" />
      <button title="添加全局音频" onClick={props.onImportAudio}><Music2 size={14} />添加音频</button>
      <button title="添加音轨" onClick={props.onAddAudioTrack}><Plus size={14} />音轨</button>
      <button aria-label="缩小时间轴" onClick={() => changeZoom(1 / 1.5)}><ZoomOut size={15} /></button>
      <button aria-label="放大时间轴" onClick={() => changeZoom(1.5)}><ZoomIn size={15} /></button>
    </div>
    {activeAudio && selectedAudio ? <div className="sequence-audio-settings"><label>音量 <input aria-label="片段音量" type="range" min="0" max="1" step="0.01" value={volumeDraft} onChange={event => { volumeDraftRef.current = Number(event.target.value); setVolumeDraft(volumeDraftRef.current); }} onPointerUp={commitVolume} onBlur={commitVolume} onKeyUp={commitVolume} /></label><label>淡入 <input aria-label="音频淡入帧数" type="number" min="0" value={activeAudio.fadeInFrames || 0} onChange={event => props.onAudioChange(selectedAudio.track, { ...activeAudio, fadeInFrames: Math.max(0, Number(event.target.value)) })} /></label><label>淡出 <input aria-label="音频淡出帧数" type="number" min="0" value={activeAudio.fadeOutFrames || 0} onChange={event => props.onAudioChange(selectedAudio.track, { ...activeAudio, fadeOutFrames: Math.max(0, Number(event.target.value)) })} /></label><button onClick={() => props.onAudioChange(selectedAudio.track, { ...activeAudio, loop: !activeAudio.loop })}>{activeAudio.loop ? '循环开' : '循环关'}</button><button onClick={() => props.onAudioChange(selectedAudio.track, { ...activeAudio, muted: !activeAudio.muted })}>{activeAudio.muted ? '取消静音' : '静音'}</button></div> : null}
    <div className="sequence-body">
      <div className="sequence-labels"><div className="sequence-label-ruler">时间</div><div className="sequence-label-video">画面主轨</div>{(project.manifest.audioTracks || []).map((track, i) => <div className="sequence-label-audio" key={track.id}>♫ {track.name || `音轨 ${i + 1}`}</div>)}</div>
      <div className="sequence-scroll" ref={scroll} title="滚轮缩放 · 中键拖动平移"
        onPointerDownCapture={beginPan} onPointerMoveCapture={movePan} onPointerUpCapture={endPan} onPointerCancelCapture={endPan}
        onLostPointerCapture={event => { if (panning.current?.pointerId === event.pointerId) { panning.current = undefined; event.currentTarget.classList.remove('panning'); } }}
        onMouseDownCapture={event => { if (event.button === 1) event.preventDefault(); }}
        onAuxClickCapture={event => { if (event.button === 1) event.preventDefault(); }}>
        <div className="sequence-content" style={{ width }}>
          <TimelineRuler viewport={scroll} fps={project.manifest.fps} pixelsPerFrame={pixelsPerFrame} width={width} onPointerDown={beginScrub} onPointerMove={scrub} onPointerUp={endScrub} onPointerCancel={endScrub} onLostPointerCapture={() => { scrubbing.current = false; }} />
          <div className="sequence-video-row" onPointerDown={seekAt}>
            {project.scenes.map((scene, index) => {
              const bounds = clipBounds(scene);
              const left = sceneStartFrame(project.scenes, index) * pixelsPerFrame;
              const clipWidth = (bounds.outFrame - bounds.inFrame) * pixelsPerFrame;
              return <div className={`sequence-scene-clip ${sceneIndex === index ? 'active' : ''} ${selectedScene === index ? 'selected' : ''}`} key={scene.id} style={{ left, width: clipWidth }}
                onPointerDown={event => { setSelectedScene(index); setSelectedAudio(undefined); begin(event, { type: 'scene', index, startX: event.clientX, delta: 0 }); }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
                <div className="sequence-clip-title">{scene.name} <small>{bounds.outFrame - bounds.inFrame} 帧</small></div>
                <Filmstrip project={project} scene={scene} index={index} />
                <span className="sequence-trim left" onPointerDown={event => begin(event, { type: 'scene', index, edge: 'start', startX: event.clientX, delta: 0 })} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
                <span className="sequence-trim right" onPointerDown={event => begin(event, { type: 'scene', index, edge: 'end', startX: event.clientX, delta: 0 })} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
              </div>;
            })}
          </div>
          {(project.manifest.audioTracks || []).map((track, trackIndex) => <div className="sequence-audio-row" key={track.id} onPointerDown={seekAt}>
            {track.clips.map(clip => <div key={clip.id} className={`sequence-audio-clip ${selectedAudio?.id === clip.id ? 'selected' : ''}`} style={{ left: clip.startFrame * pixelsPerFrame, width: clip.durationFrames * pixelsPerFrame, opacity: clip.muted ? 0.45 : 1 }}
              onPointerDown={event => { setSelectedAudio({ track: trackIndex, id: clip.id }); setSelectedScene(undefined); begin(event, { type: 'audio', index: 0, track: trackIndex, clip, startX: event.clientX, delta: 0 }); }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
              <span className="sequence-audio-name">{clip.asset.split('/').at(-1)}</span><Waveform project={project} clip={clip} />
              <span className="sequence-trim left" onPointerDown={event => begin(event, { type: 'audio', index: 0, track: trackIndex, clip, edge: 'start', startX: event.clientX, delta: 0 })} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
              <span className="sequence-trim right" onPointerDown={event => begin(event, { type: 'audio', index: 0, track: trackIndex, clip, edge: 'end', startX: event.clientX, delta: 0 })} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
            </div>)}
          </div>)}
          <div className="sequence-playhead" role="slider" tabIndex={0} aria-label="全局播放头" aria-valuemin={0} aria-valuemax={Math.max(0, length - 1)} aria-valuenow={playhead}
            style={{ left: playhead * pixelsPerFrame - 5 }} onPointerDown={beginScrub} onPointerMove={scrub} onPointerUp={endScrub} onPointerCancel={endScrub} onLostPointerCapture={() => { scrubbing.current = false; }}
            onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); props.onSeek(playhead + (event.key === 'ArrowRight' ? 1 : -1)); } else if (event.key === 'Home') { event.preventDefault(); props.onSeek(0); } else if (event.key === 'End') { event.preventDefault(); props.onSeek(length - 1); } }}><span /></div>
          {dragDelta !== 0 ? <div className="sequence-drag-hint">{dragDelta > 0 ? '+' : ''}{dragDelta} 帧</div> : null}
        </div>
      </div>
    </div>
  </div>;
}
