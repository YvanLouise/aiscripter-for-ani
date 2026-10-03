import { component, customSurface, defineScene, ease, group, random, shape, text } from '@aiscripter/sdk';
import type { FrameContext, Node, SceneFactory } from '@aiscripter/sdk';

const FONT = '"Microsoft YaHei", "Segoe UI", sans-serif';
type Card = { id: string; label: string; detail: string; style: string; tag: string };
const reveal = (time: number, delay = 0, duration = 0.9) => ease.outCubic((time - delay) / duration);
const alpha = (color: string, amount: number) => color + Math.round(Math.max(0, Math.min(1, amount)) * 255).toString(16).padStart(2, '0');

function atmosphere(width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d')!;
  const base = ctx.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, '#0b1725'); base.addColorStop(0.6, '#0b1223'); base.addColorStop(1, '#101529');
  ctx.fillStyle = base; ctx.fillRect(0, 0, width, height);
  for (const glow of [{ x: 1420, y: 390, radius: 840, color: '#7d63d628' }, { x: 800, y: 1100, radius: 950, color: '#2ca69c1a' }, { x: 0, y: 0, radius: 780, color: '#3f75b31b' }]) {
    const gradient = ctx.createRadialGradient(glow.x, glow.y, 0, glow.x, glow.y, glow.radius);
    gradient.addColorStop(0, glow.color); gradient.addColorStop(1, '#00000000');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
  }
  ctx.strokeStyle = '#9ab6db08'; ctx.lineWidth = 1; ctx.beginPath();
  for (let x = 0; x <= width; x += 80) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = 0; y <= height; y += 80) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();
  return canvas;
}

function haloTexture(): OffscreenCanvas {
  const canvas = new OffscreenCanvas(512, 512), ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(256, 256, 12, 256, 256, 256);
  gradient.addColorStop(0, '#a58aff42'); gradient.addColorStop(0.35, '#75efd31b'); gradient.addColorStop(1, '#00000000');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 512);
  return canvas;
}

function orbit(id: string, context: FrameContext, logo: OffscreenCanvas, halo: OffscreenCanvas, x: number, y: number, scale: number, time: number): Node {
  return component(id, context, {
    scale: { type: 'number', default: 1, min: 0.2, max: 2, label: '光轨尺寸' },
    accent: { type: 'color', default: '#75efd3', label: '光轨颜色' },
    secondary: { type: 'color', default: '#a58aff', label: '卫星颜色' },
  }, { scale, accent: context.params.accent, secondary: context.params.secondary }, params => {
    const s = Number(params.scale), accent = String(params.accent), secondary = String(params.secondary);
    const nodes: Node[] = [customSurface('halo', halo, { x: -530 * s, y: -480 * s, width: 1060 * s, height: 960 * s, opacity: 0.85 })];
    for (let i = 0; i < 3; i++) {
      const rx = (315 + i * 66) * s, ry = (135 + i * 20) * s, degrees = -24 + i * 28;
      nodes.push(shape(`ring-${i}`, { shape: 'ellipse', width: rx * 2, height: ry * 2, anchorX: 0.5, anchorY: 0.5, rotation: degrees, fill: '#00000000', stroke: i === 1 ? secondary : accent, strokeWidth: i === 0 ? 2 : 1, opacity: 0.24 - i * 0.035 }));
      const angle = time * (0.55 + i * 0.13) + i * 2.4, rotate = degrees * Math.PI / 180;
      const px = Math.cos(angle) * rx, py = Math.sin(angle) * ry, diameter = (i === 0 ? 30 : 18) * s;
      nodes.push(shape(`satellite-${i}`, { shape: 'ellipse', x: px * Math.cos(rotate) - py * Math.sin(rotate), y: px * Math.sin(rotate) + py * Math.cos(rotate), width: diameter, height: diameter, anchorX: 0.5, anchorY: 0.5, fill: i === 1 ? secondary : accent }));
    }
    nodes.push(shape('mark-frame', { width: 244 * s, height: 244 * s, anchorX: 0.5, anchorY: 0.5, radius: 62 * s, fill: '#121c30', stroke: '#ffffff16', strokeWidth: 1.5 }));
    nodes.push(customSurface('mark', logo, { y: Math.sin(time * 0.7) * 4 * s, width: 222 * s, height: 222 * s, anchorX: 0.5, anchorY: 0.5 }));
    return nodes;
  }, { x, y });
}

function featureCard(card: Card, index: number, context: FrameContext, time: number): Node {
  const progress = reveal(context.time, 0.45 + index * 0.16);
  return component(`card-${card.id}`, context, {
    label: { type: 'string', default: card.label, label: '卡片标题' },
    detail: { type: 'string', default: card.detail, label: '卡片文案' },
    accent: { type: 'color', default: '#75efd3', label: '强调颜色' },
    amplitude: { type: 'number', default: 24, min: 0, max: 45, label: '运动幅度' },
    style: { type: 'enum', default: 'wave', options: ['wave', 'layers', 'color'], animatable: false, label: '图形样式' },
  }, { label: card.label, detail: card.detail, style: card.style, amplitude: 24, accent: index === 1 ? context.params.secondary : context.params.accent }, params => {
    const accent = String(params.accent), amplitude = Number(params.amplitude), visual: Node[] = [];
    if (params.style === 'wave') {
      const points = Array.from({ length: 60 }, (_, i) => `${i ? 'L' : 'M'}${28 + i * 6.8} ${91 + Math.sin(i * 0.15 - time * 2.5) * amplitude * Math.sin(i / 59 * Math.PI)}`).join(' ');
      visual.push(shape('wave-glow', { shape: 'path', width: 460, height: 145, path: points, fill: '#00000000', stroke: alpha(accent, 0.12), strokeWidth: 13 }));
      visual.push(shape('wave', { shape: 'path', width: 460, height: 145, path: points, fill: '#00000000', stroke: accent, strokeWidth: 3 }));
    } else if (params.style === 'layers') {
      for (let i = 0; i < 4; i++) visual.push(shape(`plane-${i}`, { x: 115 + i * 16, y: 34 + i * 15 + Math.sin(time * 1.2 + i * 0.5) * amplitude / 5, width: 190, height: 60, radius: 12, rotation: -13, fill: alpha(accent, 0.06 + i * 0.055), stroke: alpha(accent, 0.32 + i * 0.12), strokeWidth: 1.5 }));
    } else {
      const colors = [alpha(accent, 0.8), '#a58affc9', '#80b8ffd0'];
      for (let i = 0; i < 3; i++) visual.push(shape(`color-${i}`, { shape: 'ellipse', x: 155 + i * 74, y: 85 + Math.sin(time * 0.9 + i * 1.5) * amplitude / 4, width: 96, height: 96, anchorX: 0.5, anchorY: 0.5, fill: colors[i] }));
    }
    return [
      shape('shadow', { y: 12, width: 460, height: 286, radius: 24, fill: '#00000022' }),
      shape('panel', { width: 460, height: 286, radius: 24, fill: '#132235', stroke: '#a3c4ef22', strokeWidth: 1 }),
      text('tag', card.tag, { x: 28, y: 24, fontFamily: FONT, fontSize: 16, fill: '#7f9cb5' }),
      group('visual', visual, { y: 26 }),
      text('label', String(params.label), { x: 28, y: 175, fontFamily: FONT, fontSize: 36, fontWeight: 700, fill: '#f0f7fc' }),
      text('detail', String(params.detail), { x: 28, y: 235, fontFamily: FONT, fontSize: 22, fill: '#98b2c8' }),
    ];
  }, { x: 160 + index * 570, y: 580 + (1 - progress) * 90 + Math.sin(time * 0.7 + index) * 3, opacity: progress });
}

export function createDemo(chapter: 0 | 1 | 2): SceneFactory {
  return defineScene(async ({ resources, width, height, seed }) => {
    const background = atmosphere(width, height), halo = haloTexture();
    const bitmap = await resources.image('assets/brand-icon.png'), logo = new OffscreenCanvas(512, 512);
    logo.getContext('2d')!.drawImage(bitmap, bitmap.width * 0.107, bitmap.height * 0.107, bitmap.width * 0.766, bitmap.height * 0.766, 0, 0, 512, 512);
    const cards = await resources.json<Card[]>('assets/cards.json');
    const stars = Array.from({ length: 48 }, (_, i) => ({ x: random(seed, 'x', i) * width, y: random(seed, 'y', i) * height, size: 1 + random(seed, 'size', i) * 2 }));
    return {
      parameters: {
        accent: { type: 'color', default: '#75efd3', label: '主强调色' },
        secondary: { type: 'color', default: '#a58aff', label: '辅助颜色' },
        energy: { type: 'number', default: 1, min: 0.25, max: 2, step: 0.05, label: '运动速度' },
      },
      evaluate(context) {
        const time = context.time, absolute = time + chapter * 6, motion = absolute * Number(context.params.energy);
        const accent = String(context.params.accent);
        const nodes: Node[] = [
          customSurface('background', background, { width, height }),
          group('constellation', stars.map((star, i) => shape(`star-${i}`, { shape: 'ellipse', x: star.x + Math.sin(motion * 0.15 + i) * 12, y: star.y + Math.cos(motion * 0.13 + i) * 10, width: star.size, height: star.size, fill: '#c1d9ee', opacity: 0.12 + 0.13 * (0.5 + Math.sin(motion * 0.7 + i) * 0.5) }))),
          group('brand', [
            customSurface('brand-mark', logo, { width: 38, height: 38 }),
            text('brand-name', 'AIScripter', { x: 54, fontFamily: FONT, fontSize: 27, fontWeight: 700, fill: '#f0f7fc' }),
            text('brand-suffix', 'for ani', { x: 205, y: 7, fontFamily: FONT, fontSize: 17, fill: '#819cb4' }),
          ], { x: 160, y: 70 }),
          text('chapter-label', ['01 / 灵感', '02 / 创作', '03 / 想象'][chapter], { x: 1610, y: 80, width: 150, textAlign: 'right', fontFamily: FONT, fontSize: 20, fill: '#7893a9' }),
          shape('footer-rule', { x: 160, y: 975, width: 1600, height: 1.5, fill: '#304258' }),
          shape('footer-progress', { x: 160, y: 975, width: Math.max(2, 1600 * absolute / 18), height: 1.5, fill: accent }),
          text('footer-left', 'A LITTLE IDEA. A WHOLE NEW WORLD.', { x: 160, y: 1000, fontFamily: FONT, fontSize: 14, fill: '#708ba4' }),
          text('footer-right', 'MAKE SOMETHING MOVE', { x: 1480, y: 1000, width: 280, textAlign: 'right', fontFamily: FONT, fontSize: 14, fill: '#708ba4' }),
        ];
        if (chapter === 0) {
          nodes.push(text('eyebrow', 'THE FIRST FRAME', { x: 160, y: 190, fontFamily: FONT, fontSize: 20, fill: accent, opacity: reveal(time, 0.1) }));
          const scale = 0.84 + reveal(time, 0, 1.8) * 0.16;
          nodes.push(group('hero', [orbit('hero-orbit', context, logo, halo, 0, 0, 1, motion)], { x: 1390, y: 530, scaleX: scale, scaleY: scale, opacity: 0.3 + reveal(time, 0, 1.3) * 0.7 }));
          nodes.push(group('opening-note', [shape('dot', { shape: 'ellipse', width: 8, height: 8, fill: accent }), text('note', '从这里，开始你的下一段故事', { x: 22, y: -8, fontFamily: FONT, fontSize: 20, fill: '#82a8b5' })], { x: 160, y: 756, opacity: reveal(time, 0.8) }));
        } else if (chapter === 1) {
          nodes.push(orbit('craft-orbit', context, logo, halo, 1450, 355, 0.55, motion));
          nodes.push(...cards.slice(0, 3).map((card, i) => featureCard(card, i, context, motion)));
        } else {
          nodes.push(group('finale', [orbit('finale-orbit', context, logo, halo, 0, 0, 0.88, motion)], { x: 960, y: 425, opacity: 0.5 + reveal(time, 0, 1.2) * 0.5 }));
          nodes.push(text('closing-brand', 'AIScripter for ani', { x: 610, y: 612, width: 700, textAlign: 'center', fontFamily: FONT, fontSize: 30, fill: accent, opacity: reveal(time, 0.25) }));
        }
        return nodes;
      },
    };
  });
}
