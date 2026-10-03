import { describe, expect, it } from 'vitest';
import { describeNodes, group, shape, random, noise, samplePath, spring, interpolate, ease } from './index';
describe('animation SDK', () => {
  it('uses stable random channels and analytic animations independently of frame order', () => {
    const frame = (t: number) => [random(42, 'particle-1'), noise(42, 'drift', t), spring(t), interpolate(t, [0, 1, 3], [0, 4, 10], ease.inOut)];
    const first = frame(1.2); frame(9); frame(0.3);
    expect(frame(1.2)).toEqual(first);
    expect(random(42, 'particle-1')).not.toBe(random(42, 'particle-2'));
    expect(samplePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }], 0.5)).toEqual({ x: 10, y: 10 });
  });
  it('returns stable parent addresses and rejects duplicate IDs, cycles and invalid numbers', () => {
    const child = shape('child', { x: 20, width: 50, height: 30 });
    const root = group('root', [child]);
    expect(describeNodes([root])[1]).toMatchObject({ id: 'child', parentId: 'root', width: 50 });
    expect(() => describeNodes([child, child])).toThrow('Duplicate');
    root.children = [root];
    expect(() => describeNodes([root])).toThrow('cyclic');
    expect(() => describeNodes([shape('bad', { x: Infinity })])).toThrow('Non-finite');
  });
});
