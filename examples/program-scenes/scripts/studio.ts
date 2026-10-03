import { defineScene, group, shape, text, image, random, loop, noise, ease, stagger, type Node } from '@aiscripter/sdk';
import { card } from '../components/card';

export default defineScene(async ({ width, height, seed, resources }) => {
  const data = await resources.json<{ label: string; value: number }[]>('assets/data.json');
  const logo = await resources.image('assets/mark.svg');
  const particles = Array.from({ length: 100 }, (_, i) => ({
    x: random(seed, 'particle-x', i) * width,
    y: random(seed, 'particle-y', i) * height,
    radius: random(seed, 'particle-size', i) * 3 + 2,
  }));
  return {
    parameters: {
      title: { type: 'string', default: 'Programmable studio', label: '标题' },
      accent: { type: 'color', default: '#71dfcf', label: '强调色' },
      speed: { type: 'number', default: 1, min: 0.1, max: 4, step: 0.05, label: '动画速度' },
    },
    evaluate(context): Node[] {
      const { time, params } = context;
      const t = time * Number(params.speed ?? 1), accent = String(params.accent ?? '#71dfcf');
      return [
        shape('background', { width, height, fill: '#0b1624' }),
        group('particles', particles.map((p, i) => shape('particle-' + i, {
          shape: 'ellipse', x: p.x + (noise(seed, 'drift-' + i, t * 0.25) - 0.5) * 80,
          y: loop(p.y - t * 25, height), width: p.radius * 2, height: p.radius * 2, fill: accent, opacity: 0.2,
        }))),
        group('heading', [
          image('logo', logo, { width: 64, height: 64 }),
          text('eyebrow', 'PROGRAMMABLE ANIMATION', { x: 90, y: 20, fontSize: 28, fill: accent }),
          text('title', String(params.title), { y: 110, fontSize: 100, fontWeight: 700, fill: '#f3f7ff' }),
          text('description', 'Reusable components. Direct frame evaluation. One shared engine.', { y: 248, fontSize: 32, fill: '#a1b8cc' }),
        ], { x: 160, y: 90 + (1 - ease.outCubic(t / 0.6)) * 45, opacity: ease.outCubic(t / 0.5) }),
        ...data.map((item, i) => card('card-' + i, item.label, item.value, stagger(t, i, 0.18), accent, 160 + i * 570, context)),
        shape('footer-line', { x: 160, y: 915, width: 1600, height: 2, fill: '#263d51' }),
      ];
    },
  };
});
