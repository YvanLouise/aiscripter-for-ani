import { describe, expect, it } from 'vitest';
import { evaluateExpression, validateExpression } from './expression';
import { valueAt } from './animation';
import type { Layer } from './types';

const variables = { frame: 12, time: 0.5, fps: 24, base: 10, seed: 99 };
const layer: Layer = {
  id: 'formula', name: 'Formula', type: 'shape', startFrame: 0, endFrame: 100,
  x: 10, y: 20, width: 40, height: 40, scaleX: 1, scaleY: 1,
  rotation: 0, opacity: 1, visible: true, keyframes: {},
  expressions: { x: 'base + 20 * sin(time * pi)', blur: 'base + frame / fps' },
};

describe('safe expression animation', () => {
  it('evaluates project fps and optional numeric defaults', () => {
    expect(valueAt(layer, 'x', 12, 24)).toBeCloseTo(30);
    expect(valueAt(layer, 'blur', 12, 24)).toBeCloseTo(0.5);
  });
  it('keeps deterministic noise stable for the same frame', () => {
    const expression = 'base + noise(frame * 0.2)';
    expect(evaluateExpression(expression, variables)).toBe(evaluateExpression(expression, variables));
  });
  it('rejects code, unknown methods, and invalid math', () => {
    expect(() => validateExpression('globalThis.fetch("https://example.com")')).toThrow();
    expect(() => validateExpression('constructor(1)')).toThrow();
    expect(() => validateExpression('1e999')).toThrow();
    expect(() => evaluateExpression('1 / 0', variables)).toThrow();
  });
});
