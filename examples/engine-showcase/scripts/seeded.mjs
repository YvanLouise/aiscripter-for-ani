export function render({ ctx, width, height, frame }) {
  if (!ctx) throw new Error('Canvas 2D required');
  ctx.fillStyle = '#ffe099';
  const x = 10 + Math.floor(Math.random() * 30);
  ctx.fillRect(x, height - 15, 8, 8);
  ctx.fillStyle = '#dceef0';
  ctx.font = '10px sans-serif';
  ctx.fillText(`frame ${frame} · ${Date.now()}`, width - 118, height - 9);
}
