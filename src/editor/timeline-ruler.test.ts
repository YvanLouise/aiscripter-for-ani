import { describe, expect, it } from 'vitest';
import { timelineMarkers } from './timeline-ruler';

describe('timeline ruler', () => {
  it('keeps labels separated at every supported zoom and fps', () => {
    for (const fps of [1, 24, 30, 60, 120]) {
      for (const scale of [0.4, 1, 4, 20]) {
        const markers = timelineMarkers(fps, scale, 0, 1600, 10000000);
        for (let i = 1; i < markers.length; i++) expect(markers[i].left - markers[i - 1].left).toBeGreaterThanOrEqual(80);
        expect(markers.length).toBeLessThanOrEqual(22);
      }
    }
  });
  it('limits a long project to the viewport and keeps ticks on the global grid after panning', () => {
    const markers = timelineMarkers(30, 0.4, 1000000, 1200, 10000000);
    expect(markers.length).toBeLessThanOrEqual(17);
    expect(markers[0].left).toBeLessThanOrEqual(1000000);
    expect(markers[1].left).toBeGreaterThan(1000000);
    expect(markers[0].frame % 300).toBe(0);
    expect(timelineMarkers(30, 0.4, 0, 1200, 800).at(-1)!.left).toBeLessThan(800);
  });
});
