import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { BrowserWindow } from 'electron';
import type { AiSession } from '../shared/ai-service';
import { callBridge } from './ai-bridge';
import { loadProject } from './project';

export function mcpClient(executable: string, root: string) {
  const child = spawn(process.execPath, [executable, '--project', root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
  child.on('exit', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error(`MCP exited: ${stderr}`)); } pending.clear(); });
  child.stdout.on('data', data => {
    buffer += data.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const call = pending.get(response.id);
      if (call) { clearTimeout(call.timer); pending.delete(response.id); response.error ? call.reject(new Error(JSON.stringify(response.error))) : call.resolve(response.result); }
    }
  });
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    initialize: async () => { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ani-qa', version: '1' } }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); },
    tool: async (name: string, args: unknown = {}) => { const response = await rpc('tools/call', { name, arguments: args }); if (response.isError) throw new Error(response.content[0].text); return response; },
    close: () => { child.stdin.end(); child.kill(); },
  };
}
const data = (response: any) => JSON.parse(response.content.find((item: any) => item.type === 'text').text);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const revisions = (state: AiSession) => ({ expected_draft_revision: state.draftRevision, expected_disk_revision: state.diskRevision });
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`AI QA: ${message}`); }

export async function runAiQa(editor: BrowserWindow, root: string, appRoot: string, screenshot: string): Promise<unknown> {
  const client = mcpClient(path.join(appRoot, 'dist-tools', 'aiscripter-mcp.cjs'), root);
  try {
    await client.initialize();
    const initial = await callBridge(root, { method: 'session' }) as AiSession;
    const original = initial.project.sources!['scripts/starfield.mjs'];
    await editor.webContents.executeJavaScript(`(() => {
      const label = Array.from(document.querySelectorAll('.property-row')).find(row => row.querySelector('span')?.textContent === '位置 X');
      const input = label?.querySelector('input');
      if (!input) throw new Error('Title X input missing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1134');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(80);
    let state = data(await client.tool('inspect_project')) as AiSession & AiSession['project'];
    assert(state.dirty && state.scenes[0].layers.find(layer => layer.id === 'intro-title')?.x === 1134, 'MCP must see unsaved human edit');
    const draft = { ...state, project: { ...state } } as AiSession;
    const stale = data(await client.tool('stage_changes', { ...revisions(draft), changes: [{ kind: 'update_project', patch: { name: 'Stale' } }] }));
    const stage = data(await client.tool('stage_changes', { ...revisions(draft), changes: [
      { kind: 'write_script', path: 'scripts/qa-color.mjs', source: 'export const color = [0.02, 0.08, 0.18, 1];' },
      { kind: 'write_script', path: 'scripts/starfield.mjs', source: "import { color } from './qa-color.mjs';\nexport function render({gl}) { gl.clearColor(...color); gl.clear(gl.COLOR_BUFFER_BIT); }" },
      { kind: 'update_layer', sceneId: 'introduction', layerId: 'intro-stars', patch: { params: { density: 0.55, blue: 0.8 } } },
    ] }));
    state = data(await client.tool('commit_changes', { stage_id: stage.id }));
    assert(state.project.scenes[0].layers.find(layer => layer.id === 'intro-title')?.x === 1134, 'AI overwrote title');
    let rejected = false;
    try { await client.tool('commit_changes', { stage_id: stale.id }); } catch (error) { rejected = String(error).includes('REVISION_CONFLICT'); }
    assert(rejected, 'stale stage accepted');
    const current = await callBridge(root, { method: 'session' }) as AiSession;
    const before = await editor.webContents.executeJavaScript(`({ frame: document.querySelector('.sequence-playhead')?.getAttribute('aria-valuenow'), guestId: document.querySelector('webview').getWebContentsId() })`);
    const rendered = await client.tool('render_frames', { draft_revision: current.draftRevision, frames: [37, 149, 150, 299, 37], width: 960, height: 540 });
    const images = rendered.content.filter((item: any) => item.type === 'image');
    const metadata = data(rendered);
    assert(images.length === 5 && images[0].data === images[4].data, 'same frame must be reproducible');
    assert(metadata.frames.every((frame: any) => frame.ok && !frame.errors?.length), 'snapshot render has layer errors');
    const after = await editor.webContents.executeJavaScript(`({ frame: document.querySelector('.sequence-playhead')?.getAttribute('aria-valuenow'), guestId: document.querySelector('webview').getWebContentsId() })`);
    assert(JSON.stringify(before) === JSON.stringify(after), 'hidden render changed preview/head');
    await fs.writeFile(`${screenshot}.frame.png`, Buffer.from(images[0].data, 'base64'));
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await delay(100);
    const undone = await callBridge(root, { method: 'session' }) as AiSession;
    assert(undone.project.sources?.['scripts/starfield.mjs'] === original, 'undo did not restore original source');
    assert(undone.project.scenes[0].layers.find(layer => layer.id === 'intro-title')?.x === 1134, 'undo lost human edit');
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control', 'shift'] });
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control', 'shift'] });
    await delay(100);
    const redone = await callBridge(root, { method: 'session' }) as AiSession;
    assert(redone.project.sources?.['scripts/starfield.mjs']?.includes('qa-color'), 'redo did not restore script dependency');
    const badStage = data(await client.tool('stage_changes', { ...revisions(redone), changes: [{ kind: 'write_script', path: 'scripts/starfield.mjs', source: "export function render() { throw new Error('QA_SCRIPT_FAILURE'); }" }] }));
    const badState = data(await client.tool('commit_changes', { stage_id: badStage.id }));
    const badRender = data(await client.tool('render_frames', { draft_revision: badState.draftRevision, frames: [37], width: 480, height: 270 }));
    assert(badRender.frames[0].diagnostics?.some((item: any) => item.layerId === 'intro-stars' && item.path === 'scripts/starfield.mjs' && item.message === 'QA_SCRIPT_FAILURE'), 'runtime diagnostic must locate script and layer');
    const diagnostics = data(await client.tool('get_diagnostics'));
    assert(diagnostics.runtime?.[0].errors.some((error: string) => error.includes('QA_SCRIPT_FAILURE')), 'runtime diagnostic missing');
    editor.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    editor.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await delay(100);
    const importState = await callBridge(root, { method: 'session' }) as AiSession;
    const imported = data(await client.tool('import_assets', { ...revisions(importState), relative_path: 'assets/qa-imported.json', base64: Buffer.from('{"color":"blue"}').toString('base64') }));
    assert(imported.session.project.revision === imported.session.diskRevision && imported.session.project.scenes[0].layers.find((layer: any) => layer.id === 'intro-title').x === 1134, 'import must rebase while preserving human edits');
    await delay(650);
    const conflictBanner = await editor.webContents.executeJavaScript("document.querySelector('.status-message')?.textContent");
    assert(!conflictBanner?.includes('冲突'), 'internal asset import was reported as external change');
    const exportState = await callBridge(root, { method: 'session' }) as AiSession;
    const startedExport = Date.now();
    const job = data(await client.tool('export_preview', { draft_revision: exportState.draftRevision, start_frame: 142, end_frame: 158 }));
    let jobResult;
    for (let attempt = 0; attempt < 100; attempt++) {
      jobResult = data(await client.tool('get_job', { job_id: job.id }));
      if (['complete', 'failed', 'cancelled'].includes(jobResult.state)) break;
      await delay(200);
    }
    assert(jobResult?.state === 'complete', `preview failed: ${JSON.stringify(jobResult)}`);
    await fs.copyFile(jobResult.output, `${screenshot}.preview.mp4`);
    const cancelled = data(await client.tool('export_preview', { draft_revision: exportState.draftRevision, start_frame: 0, end_frame: 300 }));
    await client.tool('cancel_job', { job_id: cancelled.id });
    let cancelledResult;
    for (let attempt = 0; attempt < 30; attempt++) {
      cancelledResult = data(await client.tool('get_job', { job_id: cancelled.id }));
      if (cancelledResult.state === 'cancelled') break;
      await delay(100);
    }
    assert(cancelledResult?.state === 'cancelled', 'preview cancellation did not complete');
    const saveState = await callBridge(root, { method: 'session' }) as AiSession;
    await client.tool('save_project', revisions(saveState));
    const reopened = await loadProject(root);
    assert(reopened.scenes[0].layers.find(layer => layer.id === 'intro-title')?.x === 1134 && reopened.sources?.['scripts/starfield.mjs']?.includes('qa-color'), 'save/reopen lost draft');
    return { machine: { platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model, cpuThreads: os.cpus().length, memoryGB: Math.round(os.totalmem() / 1024 ** 3), electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }, baseline: { inputRevision: initial.diskRevision, manifest: initial.project.manifest, totalFrames: 300 },
      unsavedHumanEdit: true, oneUndoForSceneAndScripts: true, redo: true, staleStageRejected: rejected, runtimeErrorLocated: true, importedAssetRebased: true, cancelledPreview: true, previewMilliseconds: Date.now() - startedExport, previewUnchanged: before, render: metadata,
      imageSha256: createHash('sha256').update(Buffer.from(images[0].data, 'base64')).digest('hex'), preview: { ...jobResult, output: `${screenshot}.preview.mp4` }, saveAndReopen: true };
  } finally { client.close(); }
}
