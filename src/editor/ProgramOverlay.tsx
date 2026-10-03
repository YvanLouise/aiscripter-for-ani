import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { editValue, inverseMatrix, transformPoint, type NodeDescription, type Point, type ProgramEdits } from '../sdk';

export type ProgramOverlayHandle = { begin(event: React.PointerEvent, node: NodeDescription): void };
type Gesture = { node: NodeDescription; mode: 'move' | 'scale' | 'rotate'; start: Point; center: Point; original: Record<string, number>; values: Record<string, number>; pointer: number; element: Element };
export const ProgramOverlay = forwardRef<ProgramOverlayHandle, {
  width: number; height: number; node?: NodeDescription; edits: ProgramEdits; frame: number;
  point(event: React.PointerEvent): Point; onCommit(node: NodeDescription, values: Record<string, number>): void; onInteraction(active: boolean): void;
}>(function ProgramOverlay({ width, height, node, edits, frame, point, onCommit, onInteraction }, ref) {
  const gesture = useRef<Gesture | undefined>(undefined);
  const pending = useRef<number | undefined>(undefined);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const [ghost, setGhost] = useState<Point[]>();
  useEffect(() => () => { cleanup.current?.(); }, []);
  function start(event: React.PointerEvent, target: NodeDescription, mode: Gesture['mode']) {
    if (event.button !== 0 || target.locked || !inverseMatrix(target.parentMatrix)) return;
    const properties = edits.objects?.[target.id]?.properties || {};
    const names = mode === 'move' ? ['x', 'y'] : mode === 'scale' ? ['scaleX', 'scaleY'] : ['rotation'];
    if (names.some(name => properties[name]?.locked)) return;
    event.stopPropagation(); event.preventDefault();
    const original = Object.fromEntries(names.map(name => [name, properties[name] ? Number(editValue(properties[name], frame)) : 0]));
    const center = transformPoint(target.parentMatrix, { x: Number(target.properties.x), y: Number(target.properties.y) });
    gesture.current = { node: target, mode, start: point(event), center, original, values: original, pointer: event.pointerId, element: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId); onInteraction(true);
    cleanup.current = clean;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', cancel);
  }
  useImperativeHandle(ref, () => ({ begin: (event, target) => start(event, target, 'move') }));
  function move(native: PointerEvent) {
    const active = gesture.current;
    if (!active || native.pointerId !== active.pointer) return;
    const current = point(native as unknown as React.PointerEvent), inverse = inverseMatrix(active.node.parentMatrix)!;
    const from = transformPoint(inverse, active.start), to = transformPoint(inverse, current);
    let polygon: Point[];
    if (active.mode === 'move') {
      const dx = to.x - from.x, dy = to.y - from.y;
      active.values = { x: active.original.x + dx, y: active.original.y + dy };
      polygon = active.node.polygon.map(p => ({ x: p.x + current.x - active.start.x, y: p.y + current.y - active.start.y }));
    } else if (active.mode === 'scale') {
      const ratio = Math.max(0.05, Math.hypot(current.x - active.center.x, current.y - active.center.y) / Math.max(1, Math.hypot(active.start.x - active.center.x, active.start.y - active.center.y)));
      active.values = { scaleX: active.original.scaleX + Number(active.node.properties.scaleX) * (ratio - 1), scaleY: active.original.scaleY + Number(active.node.properties.scaleY) * (ratio - 1) };
      polygon = active.node.polygon.map(p => ({ x: active.center.x + (p.x - active.center.x) * ratio, y: active.center.y + (p.y - active.center.y) * ratio }));
    } else {
      const center = transformPoint(inverse, active.center);
      const angle = Math.atan2(to.y - center.y, to.x - center.x) - Math.atan2(from.y - center.y, from.x - center.x);
      active.values = { rotation: active.original.rotation + angle * 180 / Math.PI };
      polygon = active.node.polygon.map(p => { const local = transformPoint(inverse, p), dx = local.x - center.x, dy = local.y - center.y;
        return transformPoint(active.node.parentMatrix, { x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle) }); });
    }
    if (pending.current) cancelAnimationFrame(pending.current);
    pending.current = requestAnimationFrame(() => { setGhost(polygon); pending.current = undefined; });
  }
  function clean() {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', cancel);
    if (pending.current) cancelAnimationFrame(pending.current);
    pending.current = undefined; gesture.current = undefined; setGhost(undefined); onInteraction(false);
    cleanup.current = undefined;
  }
  function end(event: PointerEvent) {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointer) return;
    clean();
    if (Object.entries(active.values).some(([name, value]) => Math.abs(value - active.original[name]) > 0.001)) onCommit(active.node, active.values);
  }
  function cancel() { clean(); }
  if (!node?.visible) return null;
  const polygon = ghost || node.polygon, radius = width / 200, top = polygon[1];
  return <svg className="program-stage-overlay" viewBox={`0 0 ${width} ${height}`} aria-label="程序对象选择框">
    <polygon points={polygon.map(p => `${p.x},${p.y}`).join(' ')} className={node.locked ? 'locked' : ''} onPointerDown={event => start(event, node, 'move')} />
    {!node.locked && <><circle aria-label="缩放程序对象" cx={polygon[2].x} cy={polygon[2].y} r={radius} onPointerDown={event => start(event, node, 'scale')} />
      <circle aria-label="旋转程序对象" cx={top.x} cy={top.y - radius * 4} r={radius} onPointerDown={event => start(event, node, 'rotate')} /></>}
  </svg>;
});
