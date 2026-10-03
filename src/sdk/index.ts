/** Versioned SDK. Coordinates use a top-left origin; rotations are in degrees. */
export const SDK_VERSION = '1.1.0';
export type Params = Readonly<Record<string, number | string | boolean>>;
export type Point = { x: number; y: number };
export type Value = number | string | boolean;
export type Parameter = { type: 'number' | 'string' | 'boolean' | 'color' | 'enum'; default: Value; label?: string; min?: number; max?: number; step?: number; options?: string[]; animatable?: boolean };
export type Parameters = Record<string, Parameter>;
export type EditKey = { frame: number; value: Value; easing?: 'linear' | 'smooth' | 'hold' };
export type PropertyEdit = { value: Value; mode?: 'replace' | 'offset'; keyframes?: EditKey[]; locked?: boolean };
export type ObjectEdit = { type: Node['type']; properties: Record<string, PropertyEdit>; locked?: boolean };
export type ProgramEdits = { parameters?: Record<string, PropertyEdit>; objects?: Record<string, ObjectEdit>; instances?: Record<string, { parameters: Record<string, PropertyEdit> }> };
export type EditDiagnostic = { target: string; message: string };
export type Matrix = [number, number, number, number, number, number];
export type Node = {
  id: string; type: 'group' | 'shape' | 'text' | 'image' | 'surface';
  x?: number; y?: number; width?: number; height?: number;
  scaleX?: number; scaleY?: number; rotation?: number; opacity?: number; visible?: boolean;
  anchorX?: number; anchorY?: number; children?: Node[]; clip?: boolean;
  shape?: 'rect' | 'ellipse' | 'line' | 'path';
  fill?: string; stroke?: string; strokeWidth?: number; radius?: number; path?: string;
  text?: string; fontSize?: number; fontFamily?: string; fontWeight?: number; textAlign?: 'left' | 'center' | 'right';
  source?: ImageBitmap | OffscreenCanvas;
  component?: { parameters: Parameters; values: Record<string, Value> };
};
export type NodeDescription = { id: string; parentId?: string; type: Node['type']; x: number; y: number; width: number; height: number;
  matrix: Matrix; parentMatrix: Matrix; polygon: Point[]; clips: Point[][]; visible: boolean; locked: boolean;
  properties: Record<string, Value>; codeProperties?: Record<string, Value>; component?: Node['component'] };
export type ProgramFeedback = { sceneId: string; frame: number; nodes: NodeDescription[]; parameters: Parameters; values: Record<string, Value>; diagnostics: EditDiagnostic[] };
export type Resources = {
  read(relative: string): Promise<ArrayBuffer>;
  text(relative: string): Promise<string>;
  json<T = unknown>(relative: string): Promise<T>;
  image(relative: string): Promise<ImageBitmap>;
  font(family: string, relative: string, descriptors?: FontFaceDescriptors): Promise<void>;
};
export type CreateContext = {
  canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D | null; gl: WebGL2RenderingContext | null;
  width: number; height: number; fps: number; durationFrames: number; seed: number; resources: Resources;
};
export type FrameContext = Omit<CreateContext, 'resources'> & { frame: number; time: number; params: Params; instances?: ProgramEdits['instances'] };
export type SceneInstance = {
  parameters?: Parameters;
  evaluate(context: FrameContext): Node[] | void | Promise<Node[] | void>;
  render?(context: FrameContext, nodes: Node[] | void): void | Promise<void>;
  dispose?(): void | Promise<void>;
};
export type SceneFactory = (context: CreateContext) => SceneInstance | Promise<SceneInstance>;
export function defineScene(create: SceneFactory): SceneFactory { return create; }

export function editValue(edit: PropertyEdit, frame: number): Value {
  const keys = edit.keyframes;
  if (!keys?.length) return edit.value;
  if (frame <= keys[0].frame) return keys[0].value;
  for (let i = 1; i < keys.length; i++) if (frame < keys[i].frame) {
    const left = keys[i - 1], right = keys[i];
    if (left.easing === 'hold') return left.value;
    let t = (frame - left.frame) / (right.frame - left.frame);
    if (left.easing === 'smooth') t = t * t * (3 - 2 * t);
    if (typeof left.value === 'number' && typeof right.value === 'number') return left.value + (right.value - left.value) * t;
    if (typeof left.value === 'string' && typeof right.value === 'string' && /^#[0-9a-f]{6}$/i.test(left.value) && /^#[0-9a-f]{6}$/i.test(right.value)) {
      return '#' + [1, 3, 5].map(offset => Math.round(parseInt(left.value.toString().slice(offset, offset + 2), 16) * (1 - t) + parseInt(right.value.toString().slice(offset, offset + 2), 16) * t).toString(16).padStart(2, '0')).join('');
    }
    return left.value;
  }
  return keys[keys.length - 1].value;
}

export function resolveParameters(descriptors: Parameters, base: Params, edits: Record<string, PropertyEdit> = {}, frame = 0): { values: Record<string, Value>; diagnostics: EditDiagnostic[] } {
  const values: Record<string, Value> = { ...base }, diagnostics: EditDiagnostic[] = [];
  const valid = (descriptor: Parameter, value: Value): boolean => {
    if (descriptor.type === 'number') return typeof value === 'number' && Number.isFinite(value) && (descriptor.min === undefined || value >= descriptor.min) && (descriptor.max === undefined || value <= descriptor.max);
    if (descriptor.type === 'boolean') return typeof value === 'boolean';
    return typeof value === 'string' && (descriptor.type !== 'color' || /^#[0-9a-f]{6}$/i.test(value)) && (descriptor.type !== 'enum' || !!descriptor.options?.includes(value));
  };
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!valid(descriptor, descriptor.default)) throw new Error(`Invalid parameter default: ${name}`);
    values[name] = valid(descriptor, base[name]) ? base[name] : descriptor.default;
    if (base[name] !== undefined && !valid(descriptor, base[name])) diagnostics.push({ target: name, message: 'Code parameter outside descriptor constraints; using default' });
  }
  for (const [name, edit] of Object.entries(edits)) {
    const descriptor = Object.hasOwn(descriptors, name) ? descriptors[name] : undefined;
    if (!descriptor && !Object.hasOwn(base, name)) { diagnostics.push({ target: name, message: 'Parameter no longer exists; override retained' }); continue; }
    if (descriptor?.animatable === false && edit.keyframes?.length) { diagnostics.push({ target: name, message: 'Parameter is no longer animatable; override retained' }); continue; }
    const value = editValue(edit, frame);
    if (descriptor ? !valid(descriptor, value) : typeof value !== typeof base[name]) { diagnostics.push({ target: name, message: 'Parameter type or range changed; override retained' }); continue; }
    values[name] = value;
  }
  return { values, diagnostics };
}

/** Each instance has an independent parameter scope and stable prefixed object IDs. */
export function component(id: string, context: FrameContext, parameters: Parameters, base: Params, evaluate: (params: Params) => Node[], props: Omit<Partial<Node>, 'id' | 'type' | 'children' | 'component'> = {}): Node {
  const resolved = resolveParameters(parameters, base, context.instances?.[id]?.parameters, context.frame);
  const prefix = (node: Node): Node => ({ ...node, id: `${id}/${node.id}`, children: node.children?.map(prefix) });
  return { ...props, id, type: 'group', children: evaluate(Object.freeze(resolved.values)).map(prefix), component: { parameters, values: resolved.values } };
}

const propertyDefaults: Record<string, Value> = { x: 0, y: 0, width: 0, height: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, visible: true, anchorX: 0, anchorY: 0,
  fill: '#ffffff', stroke: '#ffffff', strokeWidth: 0, radius: 0, text: '', fontSize: 48, fontFamily: 'Arial', fontWeight: 400, textAlign: 'left' };
export function editableProperties(node: Node): Record<string, Value> {
  const fields = ['x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'rotation', 'opacity', 'visible', 'anchorX', 'anchorY'];
  if (node.type === 'shape') fields.push('fill', 'stroke', 'strokeWidth', 'radius');
  if (node.type === 'text') fields.push('text', 'fill', 'fontSize', 'fontFamily', 'fontWeight', 'textAlign');
  return Object.fromEntries(fields.map(field => [field, (node as unknown as Record<string, Value>)[field] ?? propertyDefaults[field]]));
}
export function applyObjectEdits(nodes: Node[], edits: ProgramEdits, frame: number): { nodes: Node[]; diagnostics: EditDiagnostic[] } {
  const diagnostics: EditDiagnostic[] = [], found = new Set<string>();
  function visit(node: Node): Node {
    found.add(node.id);
    const edit = Object.hasOwn(edits.objects || {}, node.id) ? edits.objects![node.id] : undefined;
    const next: Node = { ...node, children: node.children?.map(visit) };
    if (!edit) return next;
    if (edit.type !== node.type) { diagnostics.push({ target: node.id, message: 'Object type changed; override retained without application' }); return next; }
    const base = editableProperties(node);
    for (const [name, property] of Object.entries(edit.properties)) {
      const value = editValue(property, frame);
      if (!Object.hasOwn(base, name) || typeof value !== typeof base[name] || (property.mode === 'offset' && typeof value !== 'number')) { diagnostics.push({ target: `${node.id}.${name}`, message: 'Property type changed or unsupported; override retained' }); continue; }
      const resolved = property.mode === 'offset' ? Number(base[name]) + Number(value) : value;
      if (typeof resolved === 'number' && (!Number.isFinite(resolved) || (['width', 'height', 'radius', 'strokeWidth', 'fontSize', 'fontWeight'].includes(name) && resolved < 0) || (name === 'opacity' && (resolved < 0 || resolved > 1)))) {
        diagnostics.push({ target: `${node.id}.${name}`, message: 'Override outside property range; retained without application' }); continue;
      }
      if (name === 'textAlign' && !['left', 'center', 'right'].includes(String(resolved))) { diagnostics.push({ target: `${node.id}.${name}`, message: 'Invalid text alignment' }); continue; }
      (next as unknown as Record<string, Value>)[name] = resolved;
    }
    return next;
  }
  const result = nodes.map(visit);
  for (const id of Object.keys(edits.objects || {})) if (!found.has(id)) diagnostics.push({ target: id, message: 'Object absent in this frame; override retained' });
  return { nodes: result, diagnostics };
}
export const transformPoint = (matrix: Matrix, point: Point): Point => ({ x: matrix[0] * point.x + matrix[2] * point.y + matrix[4], y: matrix[1] * point.x + matrix[3] * point.y + matrix[5] });
export function inverseMatrix(m: Matrix): Matrix | undefined {
  const determinant = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(determinant) < 1e-10) return undefined;
  return [m[3] / determinant, -m[1] / determinant, -m[2] / determinant, m[0] / determinant, (m[2] * m[5] - m[3] * m[4]) / determinant, (m[1] * m[4] - m[0] * m[5]) / determinant];
}
function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function group(id: string, children: Node[], props: Omit<Partial<Node>, 'id' | 'type' | 'children'> = {}): Node { return { ...props, id, type: 'group', children }; }
export function shape(id: string, props: Omit<Partial<Node>, 'id' | 'type'> = {}): Node { return { ...props, id, type: 'shape' }; }
export function text(id: string, value: string, props: Omit<Partial<Node>, 'id' | 'type' | 'text'> = {}): Node { return { ...props, id, type: 'text', text: value }; }
export function image(id: string, source: ImageBitmap, props: Omit<Partial<Node>, 'id' | 'type' | 'source'> = {}): Node { return { width: source.width, height: source.height, ...props, id, type: 'image', source }; }
export function customSurface(id: string, source: OffscreenCanvas, props: Omit<Partial<Node>, 'id' | 'type' | 'source'> = {}): Node { return { width: source.width, height: source.height, ...props, id, type: 'surface', source }; }
export const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));
export const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;
export const ease = {
  linear: (t: number) => clamp(t),
  inOut: (t: number) => { t = clamp(t); return t * t * (3 - 2 * t); },
  outCubic: (t: number) => 1 - (1 - clamp(t)) ** 3,
  inCubic: (t: number) => clamp(t) ** 3,
};
export function interpolate(time: number, times: readonly number[], values: readonly number[], easing: (t: number) => number = ease.linear): number {
  if (times.length !== values.length || times.length < 2 || times.some((v, i) => !Number.isFinite(v) || (i > 0 && v <= times[i - 1])) || values.some(v => !Number.isFinite(v))) throw new Error('Interpolation requires ordered times and finite values');
  if (time <= times[0]) return values[0];
  for (let i = 1; i < times.length; i++) if (time < times[i]) return lerp(values[i - 1], values[i], easing((time - times[i - 1]) / (times[i] - times[i - 1])));
  return values[values.length - 1];
}
export function loop(time: number, duration: number): number {
  if (!(duration > 0)) throw new Error('Loop duration must be positive');
  return ((time % duration) + duration) % duration;
}
export const stagger = (time: number, index: number, delay: number): number => time - index * delay;
export function spring(time: number, frequency = 2, damping = 6): number {
  if (frequency <= 0 || damping <= 0) throw new Error('Spring frequency and damping must be positive');
  if (time <= 0) return 0;
  const omega = frequency * Math.PI * 2;
  return 1 - Math.exp(-damping * time) * (Math.cos(omega * time) + damping / omega * Math.sin(omega * time));
}
export function random(seed: number, channel: string, index = 0): number {
  let hash = (seed ^ index) >>> 0;
  for (let i = 0; i < channel.length; i++) hash = Math.imul(hash ^ channel.charCodeAt(i), 16777619) >>> 0;
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d); hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b); hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}
export function noise(seed: number, channel: string, time: number): number {
  const left = Math.floor(time);
  return lerp(random(seed, channel, left), random(seed, channel, left + 1), ease.inOut(time - left));
}
export function samplePath(points: readonly Point[], progress: number): Point {
  if (points.length < 2) throw new Error('A path needs at least two points');
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let distance = clamp(progress) * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] ? distance / lengths[i] : 0;
      return { x: lerp(points[i].x, points[i + 1].x, t), y: lerp(points[i].y, points[i + 1].y, t) };
    }
    distance -= lengths[i];
  }
  return points[0];
}
export function grid(index: number, columns: number, cellWidth: number, cellHeight: number, origin: Point = { x: 0, y: 0 }): Point {
  if (!Number.isInteger(columns) || columns < 1) throw new Error('Grid columns must be a positive integer');
  return { x: origin.x + index % columns * cellWidth, y: origin.y + Math.floor(index / columns) * cellHeight };
}
export const center = (container: Point, size: Point): Point => ({ x: (container.x - size.x) / 2, y: (container.y - size.y) / 2 });

export function describeNodes(nodes: Node[], ctx?: OffscreenCanvasRenderingContext2D | null, edits: ProgramEdits = {}): NodeDescription[] {
  if (!Array.isArray(nodes)) throw new Error('evaluate() must return an array of nodes');
  const result: NodeDescription[] = [], ids = new Set<string>(), ancestors = new Set<Node>();
  function visit(node: Node, depth: number, parentId?: string, parentMatrix: Matrix = [1, 0, 0, 1, 0, 0], visible = true, locked = false, clips: Point[][] = []): NodeDescription {
    if (depth > 64 || result.length >= 10000) throw new Error('Scene exceeds 64 levels or 10000 nodes');
    if (!node || typeof node !== 'object' || ancestors.has(node)) throw new Error('Invalid or cyclic node tree');
    if (typeof node.id !== 'string' || !node.id || node.id.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(node.id) || ids.has(node.id)) throw new Error(`Duplicate, reserved or missing node ID: ${node.id}`);
    if (!['group', 'shape', 'text', 'image', 'surface'].includes(node.type)) throw new Error(`Unsupported node type: ${node.type}`);
    for (const property of ['x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'rotation', 'opacity', 'anchorX', 'anchorY', 'strokeWidth', 'radius', 'fontSize', 'fontWeight'] as const) {
      if (node[property] !== undefined && (typeof node[property] !== 'number' || !Number.isFinite(node[property]))) throw new Error(`Non-finite property: ${node.id}.${property}`);
    }
    if ((node.width ?? 0) < 0 || (node.height ?? 0) < 0 || (node.opacity ?? 1) < 0 || (node.opacity ?? 1) > 1) throw new Error(`Invalid bounds or opacity: ${node.id}`);
    if ((node.type === 'image' || node.type === 'surface') && !node.source) throw new Error(`Missing source: ${node.id}`);
    if (node.children && !Array.isArray(node.children)) throw new Error(`Invalid children: ${node.id}`);
    ids.add(node.id); ancestors.add(node);
    const angle = (node.rotation ?? 0) * Math.PI / 180, sx = node.scaleX ?? 1, sy = node.scaleY ?? 1;
    const local: Matrix = [Math.cos(angle) * sx, Math.sin(angle) * sx, -Math.sin(angle) * sy, Math.cos(angle) * sy, node.x ?? 0, node.y ?? 0];
    const matrix = multiply(parentMatrix, multiply(local, [1, 0, 0, 1, -(node.anchorX ?? 0) * (node.width ?? 0), -(node.anchorY ?? 0) * (node.height ?? 0)]));
    if (matrix.some(value => !Number.isFinite(value))) throw new Error(`Non-finite transform: ${node.id}`);
    let width = node.width ?? 0, height = node.height ?? 0, left = 0;
    if (node.type === 'text') {
      const lines = (node.text ?? '').split('\n');
      if (ctx) ctx.font = `${node.fontWeight ?? 400} ${node.fontSize ?? 48}px ${node.fontFamily ?? 'Arial'}`;
      const measured = Math.max(...lines.map(line => ctx ? ctx.measureText(line).width : line.length * (node.fontSize ?? 48) * 0.6));
      left = node.textAlign === 'center' ? width / 2 - measured / 2 : node.textAlign === 'right' ? width - measured : 0;
      width = measured; height = (node.fontSize ?? 48) * 1.2 * lines.length;
    }
    const rectangle = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].map(point => transformPoint(matrix, point));
    const ownClips = node.clip ? [...clips, rectangle(0, 0, node.width ?? 0, node.height ?? 0)] : clips;
    visible = visible && node.visible !== false && (node.opacity ?? 1) > 0;
    locked = locked || !!edits.objects?.[node.id]?.locked;
    const description: NodeDescription = { id: node.id, parentId, type: node.type, x: node.x ?? 0, y: node.y ?? 0, width, height, matrix, parentMatrix,
      polygon: rectangle(left, 0, width, height), clips: ownClips, visible, locked, properties: editableProperties(node), component: node.component };
    result.push(description);
    const children = (node.children || []).map(child => visit(child, depth + 1, node.id, matrix, visible, locked, ownClips));
    if (node.type === 'group' && !node.width && !node.height && children.length) {
      const inverse = inverseMatrix(matrix);
      if (inverse) {
        const points = children.flatMap(child => child.polygon.map(point => transformPoint(inverse, point)));
        const xs = points.map(point => point.x), ys = points.map(point => point.y), x = Math.min(...xs), y = Math.min(...ys);
        description.width = Math.max(...xs) - x; description.height = Math.max(...ys) - y;
        description.polygon = rectangle(x, y, description.width, description.height);
      }
    }
    ancestors.delete(node);
    return description;
  }
  for (const node of nodes) visit(node, 0);
  return result;
}

export function drawNodes(ctx: OffscreenCanvasRenderingContext2D, nodes: Node[]): void {
  function draw(node: Node): void {
    if (node.visible === false) return;
    ctx.save();
    try {
      const width = node.width ?? 0, height = node.height ?? 0;
      ctx.translate(node.x ?? 0, node.y ?? 0); ctx.rotate((node.rotation ?? 0) * Math.PI / 180); ctx.scale(node.scaleX ?? 1, node.scaleY ?? 1);
      ctx.translate(-(node.anchorX ?? 0) * width, -(node.anchorY ?? 0) * height); ctx.globalAlpha *= node.opacity ?? 1;
      if (node.clip) { ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip(); }
      ctx.fillStyle = node.fill ?? '#ffffff'; ctx.strokeStyle = node.stroke ?? '#ffffff'; ctx.lineWidth = node.strokeWidth ?? 1;
      if (node.type === 'shape') {
        const path = node.shape === 'path' ? new Path2D(node.path ?? '') : new Path2D();
        if (node.shape === 'ellipse') path.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
        else if (node.shape === 'line') { path.moveTo(0, 0); path.lineTo(width, height); }
        else if (node.shape !== 'path') path.roundRect(0, 0, width, height, Math.max(0, Math.min(node.radius ?? 0, width / 2, height / 2)));
        if (node.shape !== 'line' && node.fill !== 'transparent') ctx.fill(path);
        if (node.strokeWidth) ctx.stroke(path);
      } else if (node.type === 'text') {
        ctx.font = `${node.fontWeight ?? 400} ${node.fontSize ?? 48}px ${node.fontFamily ?? 'Arial'}`; ctx.textAlign = node.textAlign ?? 'left'; ctx.textBaseline = 'top';
        const x = ctx.textAlign === 'center' ? width / 2 : ctx.textAlign === 'right' ? width : 0;
        for (const [i, line] of (node.text ?? '').split('\n').entries()) ctx.fillText(line, x, i * (node.fontSize ?? 48) * 1.2);
      } else if (node.type === 'image' || node.type === 'surface') ctx.drawImage(node.source!, 0, 0, width, height);
      for (const child of node.children || []) draw(child);
    } finally { ctx.restore(); }
  }
  for (const node of nodes) draw(node);
}
