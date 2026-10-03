import type { ProgramEdits, PropertyEdit, Value } from '../sdk';

export function withValue(edit: PropertyEdit | undefined, value: Value, frame: number, key = false): PropertyEdit {
  const result: PropertyEdit = { ...edit, value: edit?.value ?? value };
  if (key || edit?.keyframes?.length) {
    result.keyframes = [...(edit?.keyframes || []).filter(item => item.frame !== frame), { frame, value, easing: edit?.keyframes?.find(item => item.frame === frame)?.easing || 'linear' }].sort((a, b) => a.frame - b.frame);
  } else result.value = value;
  return result;
}
export function setObjectValues(edits: ProgramEdits, id: string, type: 'group' | 'shape' | 'text' | 'image' | 'surface', values: Record<string, number>, frame: number): ProgramEdits {
  const object = edits.objects?.[id] || { type, properties: {} };
  if (object.locked) return edits;
  const properties = { ...object.properties };
  for (const [name, value] of Object.entries(values)) if (!properties[name]?.locked) properties[name] = withValue({ mode: 'offset', ...properties[name] }, Number(value.toFixed(name.startsWith('scale') ? 4 : 2)), frame);
  return { ...edits, objects: { ...edits.objects, [id]: { ...object, properties } } };
}
