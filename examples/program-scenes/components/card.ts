import { component, shape, text, spring, ease, type Node, type FrameContext } from '@aiscripter/sdk';

export function card(id: string, label: string, value: number, time: number, accent: string, x: number, context: FrameContext): Node {
  const progress = ease.outCubic(time / 1.2);
  return component(id, context, {
    label: { type: 'string', default: 'Metric', label: '标签' },
    value: { type: 'number', default: 50, min: 0, max: 100, label: '数值' },
    accent: { type: 'color', default: '#71dfcf', label: '强调色' },
  }, { label, value, accent }, params => [
    shape('panel', { width: 460, height: 350, radius: 28, fill: '#182c40', stroke: '#304a60', strokeWidth: 2 }),
    text('label', String(params.label), { x: 36, y: 38, fontSize: 30, fill: '#b9cbdc' }),
    text('value', Math.round(Number(params.value) * progress) + '%', { x: 36, y: 100, fontSize: 96, fontWeight: 700, fill: '#f3f7ff' }),
    shape('track', { x: 36, y: 268, width: 388, height: 14, radius: 7, fill: '#294252' }),
    shape('bar', { x: 36, y: 268, width: 388 * Number(params.value) / 100 * progress, height: 14, radius: 7, fill: String(params.accent) }),
  ], { x, y: 445 + (1 - spring(time, 1, 6)) * 100, opacity: ease.outCubic(time / 0.5) });
}
