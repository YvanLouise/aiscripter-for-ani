import type { Layer } from '../shared/types';
import { valueAt } from '../shared/animation';

const gain = (value: unknown): number => Math.max(0, Math.min(1, typeof value === 'number' && Number.isFinite(value) ? value : 1));
const number = (value: number): string => Number(value.toFixed(7)).toString();

export function volumeFilter(layer: Layer, startFrame: number, endFrame: number, fps: number): string {
  const values = Array.from({ length: endFrame - startFrame }, (_, index) => gain(valueAt(layer, 'volume', startFrame + index, fps)));
  if (!values.length) return 'volume=0';
  if (values.every(value => value === values[0])) return `volume=${number(values[0])}`;

  const points = [0];
  let from = 0;
  while (from < values.length - 1) {
    let to = from + 1;
    for (let candidate = to + 1; candidate < values.length && candidate - from <= 90; candidate++) {
      const slope = (values[candidate] - values[from]) / (candidate - from);
      let accurate = true;
      for (let frame = from + 1; frame < candidate; frame++) {
        if (Math.abs(values[frame] - (values[from] + slope * (frame - from))) > 0.001) { accurate = false; break; }
      }
      if (!accurate) break;
      to = candidate;
    }
    points.push(to);
    from = to;
  }

  let expression = number(values[points.at(-1)!]);
  for (let index = points.length - 2; index >= 0; index--) {
    const first = points[index];
    const last = points[index + 1];
    const slope = (values[last] - values[first]) / (last - first) * fps;
    const segment = `${number(values[first])}+(${number(slope)})*(t-${number(first / fps)})`;
    expression = `if(lt(t,${number(last / fps)}),${segment},${expression})`;
  }
  return `volume='${expression}':eval=frame`;
}
