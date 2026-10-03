const MIN_LABEL_SPACING = 80;
const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export function timelineMarkers(fps: number, pixelsPerFrame: number, scrollLeft: number, viewportWidth: number, contentWidth: number) {
  const pixelsPerSecond = fps * pixelsPerFrame;
  const seconds = SECOND_STEPS.find(step => step * pixelsPerSecond >= MIN_LABEL_SPACING)
    ?? Math.ceil(MIN_LABEL_SPACING / pixelsPerSecond / 3600) * 3600;
  const spacing = seconds * pixelsPerSecond;
  const first = Math.max(0, Math.floor(scrollLeft / spacing));
  const last = Math.floor(Math.min(contentWidth - 1, scrollLeft + viewportWidth + spacing) / spacing);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
    const time = (first + index) * seconds;
    const minutes = Math.floor(time / 60).toString().padStart(2, '0');
    return { frame: time * fps, left: time * pixelsPerSecond, label: `${minutes}:${(time % 60).toString().padStart(2, '0')}` };
  });
}
