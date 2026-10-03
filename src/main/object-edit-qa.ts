import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { mcpClient } from './ai-qa';
import { callBridge } from './ai-bridge';
import { loadProject } from './project';
import type { AiChange, AiSession } from '../shared/ai-service';

const data = (response: any) => JSON.parse(response.content.find((item: any) => item.type === 'text').text);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Object editing QA: ${message}`); }

export async function runObjectEditQa(editor: BrowserWindow, root: string, appRoot: string, screenshot: string): Promise<unknown> {
  const client = mcpClient(path.join(appRoot, 'dist-tools/aiscripter-mcp.cjs'), root);
  const read = () => callBridge(root, { method: 'session' }) as Promise<AiSession>;
  const js = (source: string) => editor.webContents.executeJavaScript(source);
  const checks: Record<string, boolean> = {};
  async function waitFor(source: string, name: string) {
    for (let attempt = 0; attempt < 80; attempt++) { if (await js(source)) return; await delay(100); }
    throw new Error(`Object editing QA: timed out waiting for ${name}`);
  }
  async function click(label: string) { await js(`document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}).click()`); await delay(150); }
  async function input(label: string, value: string) {
    await js(`(() => { const element = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}); if (!element) throw new Error('Missing field'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await delay(200);
  }
  async function select(id: string) {
    await js(`document.querySelector(${JSON.stringify(`[data-program-object="${id}"]`)}).click()`); await delay(150);
  }
  async function apply(changes: AiChange[]) {
    const state = await read();
    const staged = data(await client.tool('stage_changes', { expected_draft_revision: state.draftRevision, expected_disk_revision: state.diskRevision, changes }));
    return data(await client.tool('commit_changes', { stage_id: staged.id }));
  }
  async function render(frames: number[]) {
    const response = await client.tool('render_frames', { draft_revision: (await read()).draftRevision, frames });
    const metadata = data(response).frames;
    assert(metadata.every((item: any) => item.ok && !item.errors.length && item.programEdit), JSON.stringify(metadata.map((item: any) => item.errors)));
    return { frames: metadata, images: response.content.filter((item: any) => item.type === 'image') };
  }
  try {
    await client.initialize();
    assert(data(await client.tool('get_capabilities')).programEditing.humanOverrides, 'MCP editing capabilities absent');
    await js(`document.querySelectorAll('.scene-item')[1].click(); document.querySelector('.sequence-playhead').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));`);
    await delay(200);
    await js(`document.querySelector('.program-scene-entry').click()`);
    await waitFor(`!!document.querySelector('[data-program-object="heading"]')`, 'object tree');
    assert((await read()).playhead === 449, 'global playhead mapping');
    await input('场景参数 title', 'HUMAN + AI STUDIO');
    await click('关键帧 场景参数 speed');
    await input('场景参数 speed 关键帧时间 299', '0');
    await input('场景参数 speed', '2');
    const keyed = await render([150, 299, 449]);
    assert(keyed.frames[0].programEdit.values.speed === 1 && keyed.frames[2].programEdit.values.speed === 2 && keyed.frames[1].programEdit.values.speed > 1.4, 'public parameter keys did not evaluate');
    checks.publicParameterKeys = true;

    await select('heading');
    await input('对象属性 x', '75');
    let before = await read();
    assert(before.project.scenes[1].program?.edits?.objects?.heading.properties.x.value === 75, 'object property input failed');
    await waitFor(`!!document.querySelector('.program-stage-overlay polygon')`, 'selection overlay');
    const bounds = await js(`(() => { const svg = document.querySelector('.program-stage-overlay'), box = svg.getBoundingClientRect(); const points = svg.querySelector('polygon').getAttribute('points').split(' ').map(p => p.split(',').map(Number)); const x = points.reduce((sum,p)=>sum+p[0],0)/4, y = points.reduce((sum,p)=>sum+p[1],0)/4; return { x: Math.round(box.x+x/1920*box.width), y: Math.round(box.y+y/1080*box.height), width: box.width }; })()`);
    editor.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x, y: bounds.y });
    editor.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: bounds.x, y: bounds.y });
    editor.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x + 20, y: bounds.y + 10 });
    await delay(80);
    editor.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: bounds.x + 20, y: bounds.y + 10 });
    await delay(300);
    const moved = await read(), movement = moved.project.scenes[1].program!.edits!.objects!.heading.properties.x.value as number;
    assert(Math.abs(movement - 75 - 20 / bounds.width * 1920) < 5, `canvas drag failed: ${movement}`);
    await js(`document.querySelector('button[title="撤销 (Ctrl+Z)"]').click()`); await delay(200);
    assert((await read()).project.scenes[1].program?.edits?.objects?.heading.properties.x.value === 75, 'gesture was not one undo record');
    await js(`document.querySelector('button[title="重做 (Ctrl+Shift+Z)"]').click()`); await delay(200);
    assert((await read()).project.scenes[1].program?.edits?.objects?.heading.properties.x.value === movement, 'gesture redo failed');
    checks.canvasDrag = true; checks.gestureUndoRedo = true;
    async function dragHandle(label: string, dx: number, dy: number) {
      await waitFor(`!!document.querySelector('[aria-label="${label}"]')`, label);
      const rect = await js(`document.querySelector('[aria-label="${label}"]').getBoundingClientRect().toJSON()`);
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      editor.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
      editor.webContents.sendInputEvent({ type: 'mouseMove', x: x + dx, y: y + dy }); await delay(80);
      editor.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: x + dx, y: y + dy }); await delay(300);
    }
    await dragHandle('缩放程序对象', 12, 8);
    assert(Number((await read()).project.scenes[1].program?.edits?.objects?.heading.properties.scaleX.value) > 0, 'scale handle failed');
    await dragHandle('旋转程序对象', 0, 15);
    assert(Math.abs(Number((await read()).project.scenes[1].program?.edits?.objects?.heading.properties.rotation.value)) > 0.1, 'rotation handle failed');
    checks.canvasScaleRotate = true;

    await select('card-0'); await input('实例参数 card-0/value', '88');
    const instances = (await render([449])).frames[0].programEdit.nodes;
    assert(instances.find((node: any) => node.id === 'card-0').component.values.value === 88 && instances.find((node: any) => node.id === 'card-1').component.values.value !== 88, 'component parameters leaked into another instance');
    checks.independentInstances = true;
    await click('锁定程序对象');
    before = await read();
    let denied = false;
    try { await client.tool('stage_changes', { expected_draft_revision: before.draftRevision, expected_disk_revision: before.diskRevision, changes: [{ kind: 'write_script', path: 'components/card.ts', source: before.project.sources!['components/card.ts'] + '\n' }] }); }
    catch (error) { denied = String(error).includes('LOCKED'); }
    assert(denied, 'MCP bypassed object lock');
    await click('锁定程序对象'); checks.mcpLocks = true;

    before = await read(); const original = before.project.sources!['scripts/studio.ts'];
    const humanEdits = JSON.stringify(before.project.scenes[1].program?.edits);
    const changed = original.replace('{ x: 160, y: 90', '{ x: 200, y: 90');
    assert(changed !== original, 'QA code patch did not match');
    await apply([{ kind: 'write_script', path: 'scripts/studio.ts', source: changed }]);
    const updated = await render([449, 187, 449]);
    assert(updated.frames[0].programEdit.nodes.find((node: any) => node.id === 'heading').properties.x === 200 + movement, 'human offset did not follow changed code');
    assert(updated.frames[0].programEdit.values.title === 'HUMAN + AI STUDIO' && JSON.stringify((await read()).project.scenes[1].program?.edits) === humanEdits, 'AI discarded human edits');
    assert(updated.images[0].data === updated.images[2].data, 'edited seek nondeterminism');
    checks.aiPreservesEdits = true; checks.deterministicEditedSeek = true;
    await fs.writeFile(screenshot + '.frame.png', Buffer.from(updated.images[0].data, 'base64'));

    await apply([{ kind: 'write_script', path: 'scripts/studio.ts', source: changed.replace("group('heading'", "group('heading-renamed'") }]);
    const unbound = (await render([449])).frames[0].programEdit.diagnostics;
    assert(unbound.some((item: any) => item.target === 'heading'), 'missing stable ID was silently discarded');
    await waitFor(`document.querySelector('.program-inspector')?.textContent.includes('Object absent in this frame')`, 'unbound override warning');
    assert(JSON.stringify((await read()).project.scenes[1].program?.edits) === humanEdits, 'unbound edit deleted');
    await js(`(() => { const select = document.querySelector('[aria-label="重新绑定对象 heading"]'); select.value = 'heading-renamed'; select.dispatchEvent(new Event('change', { bubbles:true })); })()`);
    await delay(250);
    const rebound = (await render([449])).frames[0].programEdit;
    assert(!rebound.diagnostics.length && rebound.nodes.find((node: any) => node.id === 'heading-renamed').properties.x === 200 + movement, 'manual ID binding failed');
    await js(`document.querySelector('button[title="撤销 (Ctrl+Z)"]').click()`); await delay(200);
    assert(JSON.stringify((await read()).project.scenes[1].program?.edits) === humanEdits, 'manual binding undo lost edits'); checks.manualRebind = true;
    await apply([{ kind: 'write_script', path: 'scripts/studio.ts', source: changed }]);
    assert(!(await render([449])).frames[0].programEdit.diagnostics.length, 'restored stable ID did not rebind'); checks.unboundRecovery = true;

    before = await read();
    const job = data(await client.tool('export_preview', { draft_revision: before.draftRevision, start_frame: 150, end_frame: 180 }));
    let result;
    for (let attempt = 0; attempt < 150; attempt++) { result = data(await client.tool('get_job', { job_id: job.id })); if (['complete', 'failed', 'cancelled'].includes(result.state)) break; await delay(200); }
    assert(result?.state === 'complete', `edited export failed: ${JSON.stringify(result)}`);
    await fs.copyFile(result.output, screenshot + '.preview.mp4'); checks.editedExport = true;
    before = await read();
    await client.tool('save_project', { expected_draft_revision: before.draftRevision, expected_disk_revision: before.diskRevision });
    assert(JSON.stringify((await loadProject(root)).scenes[1].program?.edits) === humanEdits, 'save/reopen discarded edits'); checks.saveReopen = true;
    await select('heading');
    await js(`document.querySelector('.program-object-inspector').scrollIntoView({block:'start'}); document.querySelector('.sequence-scroll').scrollLeft = 1e6;`);
    await delay(250);
    checks.nonBlankUi = !!(await js(`document.querySelector('.program-object-inspector') && document.querySelector('.program-stage-overlay polygon') && document.querySelector('.canvas-scene').textContent.includes('Program studio')`));
    return { ...checks, frameSha256: createHash('sha256').update(Buffer.from(updated.images[0].data, 'base64')).digest('hex'), humanEdits: JSON.parse(humanEdits), unbound, frame: updated.frames[0].programEdit, output: screenshot + '.preview.mp4' };
  } finally { client.close(); }
}
