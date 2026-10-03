import { describe, expect, it } from 'vitest';
import { applyObjectEdits, component, describeNodes, editValue, group, inverseMatrix, pointInPolygon, resolveParameters, shape, text, transformPoint, type FrameContext, type Parameters, type ProgramEdits } from './index';
import { setObjectValues, withValue } from '../editor/program-edit';

describe('program object editing', () => {
  it('evaluates numeric, color and discrete keys without seek state', () => {
    const track = { value: 0, keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 100 }] };
    expect(editValue(track, 5)).toBe(50); expect(editValue(track, 10)).toBe(100); expect(editValue(track, 5)).toBe(50);
    expect(editValue({ value: '#000000', keyframes: [{ frame: 0, value: '#000000' }, { frame: 10, value: '#ffffff' }] }, 5)).toBe('#808080');
    expect(editValue({ value: false, keyframes: [{ frame: 0, value: false }, { frame: 10, value: true }] }, 9)).toBe(false);
    expect(editValue({ value: 0, keyframes: [{ frame: 0, value: 0, easing: 'hold' }, { frame: 10, value: 10 }] }, 9)).toBe(0);
  });
  it('retains missing and changed objects and composes offsets with changed code values', () => {
    const edits: ProgramEdits = { objects: { title: { type: 'text', properties: { x: { value: 20, mode: 'offset' }, text: { value: 'Human' } } }, removed: { type: 'shape', properties: {} } } };
    const result = applyObjectEdits([text('title', 'AI', { x: 100 })], edits, 0);
    expect(result.nodes[0]).toMatchObject({ x: 120, text: 'Human' }); expect(result.diagnostics[0].target).toBe('removed');
    expect(applyObjectEdits([text('title', 'New AI', { x: 200 })], edits, 0).nodes[0].x).toBe(220);
    const changed = applyObjectEdits([shape('title', { x: 200 })], edits, 0);
    expect(changed.nodes[0].x).toBe(200); expect(changed.diagnostics[0].message).toContain('type changed');
    expect(edits.objects!.title.properties.text.value).toBe('Human');
  });
  it('maps transformed, anchored and clipped objects to world coordinates', () => {
    const nodes = describeNodes([group('parent', [shape('child', { x: 20, y: 10, width: 100, height: 40, anchorX: 0.5 })], { x: 100, y: 200, rotation: 90, scaleX: 2, scaleY: 2, width: 200, height: 100, clip: true })]);
    const child = nodes[1], local = { x: 25, y: 20 }, world = transformPoint(child.matrix, local);
    expect(transformPoint(inverseMatrix(child.matrix)!, world).x).toBeCloseTo(25);
    expect(pointInPolygon(world, child.polygon)).toBe(true); expect(child.clips).toHaveLength(1);
    expect(inverseMatrix([0, 0, 0, 1, 0, 0])).toBeUndefined();
    expect(describeNodes([group('g', [shape('a', { x: 20, y: 10, width: 100, height: 50 })])])[0].polygon[0]).toEqual({ x: 20, y: 10 });
  });
  it('inherits locks and validates changed parameter descriptors', () => {
    const nodes = describeNodes([group('p', [text('t', 'title')])], null, { objects: { p: { type: 'group', properties: {}, locked: true } } });
    expect(nodes[1].locked).toBe(true); expect(nodes[1].width).toBeGreaterThan(0);
    const descriptors: Parameters = { speed: { type: 'number', default: 1, min: 0, max: 3 }, fixed: { type: 'boolean', default: false, animatable: false } };
    const resolved = resolveParameters(descriptors, {}, { speed: { value: 99 }, missing: { value: 'x' }, fixed: { value: true, keyframes: [{ frame: 1, value: false }] } });
    expect(resolved.values.speed).toBe(1); expect(resolved.diagnostics).toHaveLength(3);
  });
  it('keeps component instances independent with prefixed IDs and keyframes', () => {
    const context = { frame: 5, instances: { first: { parameters: { size: { value: 100, keyframes: [{ frame: 0, value: 100 }, { frame: 10, value: 200 }] } } } } } as unknown as FrameContext;
    const parameters: Parameters = { size: { type: 'number', default: 10 } };
    const create = (id: string) => component(id, context, parameters, {}, params => [shape('panel', { width: Number(params.size), height: 10 })]);
    const nodes = [create('first'), create('second')];
    expect(nodes[0].children![0]).toMatchObject({ id: 'first/panel', width: 150 }); expect(nodes[1].children![0]).toMatchObject({ id: 'second/panel', width: 10 });
    expect(describeNodes(nodes)).toHaveLength(4);
  });
  it('adds keys to an animated property and preserves locked properties during gestures', () => {
    expect(withValue({ value: 0, keyframes: [{ frame: 0, value: 0 }] }, 25, 10).keyframes?.map(key => key.frame)).toEqual([0, 10]);
    const edits: ProgramEdits = { objects: { a: { type: 'shape', properties: { x: { value: 10, locked: true } } } } };
    const next = setObjectValues(edits, 'a', 'shape', { x: 20, y: 30 }, 0);
    expect(next.objects!.a.properties.x.value).toBe(10); expect(next.objects!.a.properties.y).toEqual({ mode: 'offset', value: 30 });
  });
});
