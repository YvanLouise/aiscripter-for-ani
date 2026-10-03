export const programTemplate = `import { defineScene, shape, text, group, ease, spring, random, loop } from '@aiscripter/sdk';

export default defineScene(({ width, height, seed }) => {
  const particles = Array.from({ length: 60 }, (_, i) => ({
    x: random(seed, 'x', i) * width,
    y: random(seed, 'y', i) * height,
    radius: 2 + random(seed, 'size', i) * 5,
    speed: 15 + random(seed, 'speed', i) * 35,
  }));
  return {
    parameters: {
      title: { type: 'string', default: 'Programmable scenes', label: '标题' },
      accent: { type: 'color', default: '#71dfcf', label: '强调色' },
    },
    evaluate({ time, params }) {
      const accent = String(params.accent ?? '#71dfcf');
      return [
        shape('background', { width, height, fill: '#0b1624' }),
        group('particles', particles.map((p, i) => shape('particle-' + i, {
          shape: 'ellipse', x: p.x, y: loop(p.y + time * p.speed, height),
          width: p.radius * 2, height: p.radius * 2, fill: accent, opacity: 0.25,
        }))),
        group('title-card', [
          shape('panel', { width: width * 0.72, height: height * 0.38, radius: 28, fill: '#16283b', stroke: accent, strokeWidth: 2 }),
          text('title', String(params.title ?? 'Programmable scenes'), { x: 48, y: 50, fontSize: width * 0.044, fontWeight: 700, fill: '#f0f7ff' }),
          text('subtitle', 'TypeScript / reusable modules / seeded animation', { x: 48, y: height * 0.23, fontSize: width * 0.018, fill: accent }),
        ], { x: width * 0.14, y: height * 0.3 + (1 - spring(time, 1.2, 7)) * 90, opacity: ease.outCubic(time / 0.6) }),
      ];
    },
  };
});
`;
