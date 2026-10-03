import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { webContents, type BrowserWindow } from 'electron';
import { mcpClient } from './ai-qa';
import { callBridge } from './ai-bridge';
import { loadProject } from './project';
import type { AiChange, AiSession } from '../shared/ai-service';

const data = (response: any) => JSON.parse(response.content.find((item: any) => item.type === 'text').text);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Program QA: ${message}`); }

export async function runProgramQa(editor: BrowserWindow, root: string, appRoot: string, screenshot: string): Promise<unknown> {
  const client = mcpClient(path.join(appRoot, 'dist-tools/aiscripter-mcp.cjs'), root);
  const read = () => callBridge(root, { method: 'session' }) as Promise<AiSession>;
  async function apply(changes: AiChange[]): Promise<AiSession> {
    const state = await read();
    const staged = data(await client.tool('stage_changes', { expected_draft_revision: state.draftRevision, expected_disk_revision: state.diskRevision, changes }));
    return data(await client.tool('commit_changes', { stage_id: staged.id }));
  }
  async function render(frames: number[]) {
    const state = await read();
    const response = await client.tool('render_frames', { draft_revision: state.draftRevision, frames });
    return { metadata: data(response).frames, images: response.content.filter((item: any) => item.type === 'image') };
  }
  try {
    await client.initialize();
    assert(data(await client.tool('get_capabilities')).programmableScenesV3, 'v3 capability missing');
    await editor.webContents.executeJavaScript(`document.querySelectorAll('.scene-item')[1].click()`);
    await delay(200);
    await editor.webContents.executeJavaScript(`document.querySelector('.program-scene-entry').click()`);
    await delay(150);
    await editor.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('[aria-label="场景参数 title"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      if (!input) throw new Error('Program inspector missing');
      setter.call(input, 'AI PROGRAM QA'); input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(200);
    const initial = await read();
    assert(initial.project.scenes[1].program?.edits?.parameters?.title?.value === 'AI PROGRAM QA', 'parameter editor did not update draft');
    await editor.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.program-inspector button')).find(button => button.textContent === '编辑入口代码').click()`);
    await delay(120);
    const moduleText = await editor.webContents.executeJavaScript(`document.querySelector('.script-modal textarea')?.value`);
    assert(moduleText?.includes('../components/card'), 'TypeScript entry editor missing');
    await editor.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.script-modal-footer button')).find(button => button.textContent === '关闭').click()`);
    const built = data(await client.tool('build_project', { draft_revision: (await read()).draftRevision }));
    assert(built.ok, `build failed: ${JSON.stringify(built)}`);
    const frames = await render([187, 240, 187, 149, 150, 187]);
    assert(frames.metadata.every((item: any) => item.ok && !item.errors.length), `render failed: ${JSON.stringify(frames.metadata)}`);
    const first = frames.metadata[0].programStats;
    assert(first?.initialized && frames.metadata[1].programStats.instanceId === first.instanceId && !frames.metadata[1].programStats.initialized, 'program instance was recreated between frames');
    assert(frames.images[0].data === frames.images[2].data && frames.images[0].data === frames.images[5].data, 'seeking changed the same frame');
    assert(!frames.metadata[3].programStats && frames.metadata[4].frame === 0 && frames.metadata[4].programStats.instanceId === first.instanceId, 'mixed scene boundary mapping failed');
    await fs.writeFile(`${screenshot}.frame.png`, Buffer.from(frames.images[0].data, 'base64'));
    const original = (await read()).project.sources!['scripts/studio.ts'];
    await apply([{ kind: 'write_script', path: 'scripts/studio.ts', source: original + '\nconst broken: number = "wrong";\n' }]);
    const invalid = data(await client.tool('build_project', { draft_revision: (await read()).draftRevision }));
    assert(!invalid.ok && invalid.diagnostics.some((item: any) => item.path === 'scripts/studio.ts' && item.line), 'type error not located');
    assert((await render([187])).metadata[0].errors.length, 'compiler failure did not show an editable scene error');
    const checksSource = `import { defineScene, shape, text } from '@aiscripter/sdk';
export default defineScene(async ({ resources, width, height }) => {
  await resources.font('QA Font', 'assets/qa-font.ttf');
  let denied = 0;
  for (const path of ['../outside.txt', '.aiscripter/mcp-session.json']) { try { await resources.read(path); } catch { denied++; } }
  try { await fetch('https://example.com/'); } catch { denied++; }
  if (typeof (globalThis as any).process !== 'undefined' || denied !== 3) throw new Error('Permission boundary failed');
  return { async evaluate() {
    let blocked = false; try { await resources.text('assets/data.json'); } catch { blocked = true; }
    if (!blocked) throw new Error('Runtime resource load should be initialization-only');
    return [shape('ok', { width, height, fill: '#71dfcf' }), text('font', 'Project font loaded', { x: 40, y: 40, fontFamily: 'QA Font', fill: '#122331' })];
  } };
});`;
    await apply([{ kind: 'write_script', path: 'scripts/studio.ts', source: checksSource }]);
    assert(!(await render([187])).metadata[0].errors.length, 'resource or network boundary checks failed');
    const hanging = `import { defineScene, shape } from '@aiscripter/sdk';
export default defineScene(({ width, height }) => ({ evaluate({ frame }) {
  if (frame === 0) { while (true) {} }
  if (frame === 2) throw new Error('QA exception');
  return [shape('recovered', { width, height, fill: '#4567aa' })];
} }));`;
    await apply([{ kind: 'write_script', path: 'scripts/studio.ts', source: hanging }]);
    const recovered = await render([150, 151, 152, 151]);
    assert(recovered.metadata[0].errors[0]?.includes('8 second') && !recovered.metadata[1].errors.length && recovered.metadata[1].programStats.initialized, 'timed-out instance did not recover');
    assert(recovered.metadata[2].diagnostics[0]?.message === 'QA exception' && !recovered.metadata[3].errors.length && recovered.images[1].data === recovered.images[3].data, 'exception recovery failed');
    const webgl = `import { defineScene } from '@aiscripter/sdk';
export default defineScene(({ gl }) => {
  if (!gl) throw new Error('WebGL2 context missing');
  return { evaluate() {}, render({ time }) { gl.clearColor(0.1, 0.25 + Math.sin(time) * 0.1, 0.55, 1); gl.clear(gl.COLOR_BUFFER_BIT); } };
});`;
    await apply([{ kind: 'write_script', path: 'scripts/studio.ts', source: webgl }, { kind: 'update_scene', sceneId: 'program', patch: { program: { ...initial.project.scenes[1].program!, renderer: 'webgl2' } } }]);
    const glFrames = await render([187, 240, 187]);
    assert(glFrames.metadata.every((item: any) => !item.errors.length) && glFrames.images[0].data === glFrames.images[2].data && !glFrames.metadata[1].programStats.initialized, 'WebGL2 lifecycle or seeking failed');
    await apply([{ kind: 'write_script', path: 'scripts/studio.ts', source: original }, { kind: 'update_scene', sceneId: 'program', patch: { program: initial.project.scenes[1].program } }]);
    const state = await read();
    const job = data(await client.tool('export_preview', { draft_revision: state.draftRevision, start_frame: 142, end_frame: 202 }));
    let finished;
    for (let attempt = 0; attempt < 150; attempt++) {
      finished = data(await client.tool('get_job', { job_id: job.id }));
      if (['complete', 'failed', 'cancelled'].includes(finished.state)) break;
      await delay(200);
    }
    assert(finished?.state === 'complete', `mixed preview export failed: ${JSON.stringify(finished)}`);
    await fs.copyFile(finished.output, `${screenshot}.preview.mp4`);
    const saveState = await read();
    await client.tool('save_project', { expected_draft_revision: saveState.draftRevision, expected_disk_revision: saveState.diskRevision });
    const reopened = await loadProject(root);
    assert(reopened.manifest.formatVersion === 3 && reopened.scenes[1].program?.edits?.parameters?.title?.value === 'AI PROGRAM QA', 'v3 save/reopen failed');
    let previewPixel: number[] | undefined;
    const guestId = await editor.webContents.executeJavaScript('document.querySelector("webview").getWebContentsId()');
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(150);
      const status = await editor.webContents.executeJavaScript('document.querySelector(".status-message").textContent');
      previewPixel = await webContents.fromId(guestId)!.executeJavaScript('Array.from(document.querySelector("canvas").getContext("2d").getImageData(10, 10, 1, 1).data)');
      if (!status.includes('8 second') && previewPixel?.[0] === 11 && previewPixel?.[1] === 22) break;
    }
    assert(previewPixel?.[0] === 11 && previewPixel?.[1] === 22 && previewPixel?.[2] === 36, 'visible preview retained a stale error after code restoration');
    await editor.webContents.executeJavaScript(`(() => {
      document.querySelector('.sequence-playhead').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      const scroll = document.querySelector('.sequence-scroll'); scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth;
    })()`);
    await delay(300);
    assert((await read()).playhead === 449, 'visible global seek failed');
    return { parameterEditor: true, moduleEditor: true, typeDiagnostics: invalid.diagnostics, initializationReused: true,
      deterministicSeek: true, mixedBoundary: true, resourcePermissions: true, projectFont: true, timeoutRecovery: true, exceptionRecovery: true, webglReuse: true,
      mixedExport: true, saveReopen: true, visibleRecovery: true, previewPixel, frameSha256: createHash('sha256').update(Buffer.from(frames.images[0].data, 'base64')).digest('hex'), frames: frames.metadata, recovery: recovered.metadata };
  } finally { client.close(); }
}
