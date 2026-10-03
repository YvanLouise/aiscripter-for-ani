import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { webContents, type BrowserWindow } from 'electron';
import { mcpClient } from './ai-qa';
import { callBridge } from './ai-bridge';
import { loadProject } from './project';
import type { AiSession } from '../shared/ai-service';

const data = (response: any) => JSON.parse(response.content.find((item: any) => item.type === 'text').text);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Default animation QA: ${message}`); }

export async function runDefaultDemoQa(editor: BrowserWindow, root: string, appRoot: string, screenshot: string) {
  const client = mcpClient(path.join(appRoot, 'dist-tools/aiscripter-mcp.cjs'), root);
  const read = () => callBridge(root, { method: 'session' }) as Promise<AiSession>;
  const js = (source: string) => editor.webContents.executeJavaScript(source);
  async function waitFor(source: string, name: string) {
    for (let attempt = 0; attempt < 100; attempt++) { if (await js(source)) return; await delay(100); }
    throw new Error(`Default animation QA: waiting for ${name}`);
  }
  async function render(frames: number[]) {
    const metadata: any[] = [], images: any[] = [];
    // Full-resolution PNG batches must fit the bridge's bounded response size.
    for (let offset = 0; offset < frames.length; offset += 2) {
      const response = await client.tool('render_frames', { draft_revision: (await read()).draftRevision, frames: frames.slice(offset, offset + 2), width: 1920, height: 1080 });
      metadata.push(...data(response).frames); images.push(...response.content.filter((item: any) => item.type === 'image'));
    }
    assert(metadata.length === frames.length && metadata.every((item: any) => item.ok && !item.errors.length && item.programEdit && !item.programEdit.diagnostics.length), JSON.stringify(metadata.map((item: any) => item.errors)));
    return { metadata, images };
  }
  async function seek(frame: number) {
    const location = await js(`(() => {
      const scroll = document.querySelector('.sequence-scroll'), content = document.querySelector('.sequence-content');
      const scale = document.querySelector('.sequence-scene-clip').getBoundingClientRect().width / 180;
      scroll.scrollLeft = Math.max(0, ${frame} * scale - scroll.clientWidth / 2);
      const ruler = document.querySelector('.sequence-ruler').getBoundingClientRect();
      return { x: Math.round(content.getBoundingClientRect().x + ${frame} * scale), y: Math.round(ruler.y + 18) };
    })()`);
    editor.webContents.sendInputEvent({ type: 'mouseMove', ...location });
    editor.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...location });
    editor.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...location });
    await waitFor(`Number(document.querySelector('.sequence-playhead').getAttribute('aria-valuenow')) === ${frame}`, 'seek');
    await delay(300);
  }
  async function input(selector: string, value: string) {
    await js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw new Error('Missing input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await delay(200);
  }
  try {
    await client.initialize();
    const initial = await read();
    assert(path.basename(root) === 'default-animation-project' && initial.project.manifest.id === 'aiscripter-default-motion', 'startup did not use the managed default');
    assert(initial.project.scenes.length === 3 && initial.project.scenes.reduce((sum, scene) => sum + scene.durationFrames, 0) === 540 && initial.playhead === 75, 'startup storyboard or frame');
    const guestId = await js('document.querySelector("webview").getWebContentsId()'), guest = webContents.fromId(guestId)!;
    const preview = () => guest.executeJavaScript('document.querySelector("canvas").toDataURL()');
    const before = await preview();
    const frames = await render([75, 255, 450, 179, 180, 539]);
    for (const [index, name] of ['inspiration', 'craft', 'imagination'].entries()) await fs.writeFile(path.join(path.dirname(screenshot), `${name}.png`), Buffer.from(frames.images[index].data, 'base64'));
    const repeated = await render([75, 359, 360, 450, 75]);
    assert(repeated.images[0].data === repeated.images[4].data && repeated.images[0].data === frames.images[0].data, 'random-access rendering changed the same frame');
    assert(frames.metadata[3].sceneId === 'inspiration' && frames.metadata[3].frame === 179 && frames.metadata[4].sceneId === 'craft' && frames.metadata[4].frame === 0
      && repeated.metadata[1].frame === 179 && repeated.metadata[2].sceneId === 'imagination' && repeated.metadata[2].frame === 0, 'chapter seam mapping');
    assert(await preview() === before && (await read()).playhead === 75 && await js('document.querySelector("webview").getWebContentsId()') === guestId, 'hidden rendering changed the visible preview');
    assert(frames.metadata[1].programEdit.nodes.find((node: any) => node.id === 'card-rhythm').component.values.style === 'wave', 'editable card component absent');
    await js(`(() => { const row = Array.from(document.querySelectorAll('.property-row')).find(row => row.querySelector('span')?.textContent === '位置 X'); row.querySelector('input').setAttribute('data-default-title', 'true'); })()`);
    await input('[data-default-title]', '650');
    assert((await read()).project.scenes[0].layers[0].x === 650, 'native title cannot be edited');
    await seek(255);
    await js('document.querySelector(".program-scene-entry").click()');
    await waitFor(`!!document.querySelector('[data-program-object="card-rhythm"]')`, 'card tree');
    await js(`document.querySelector('[data-program-object="card-rhythm"]').click()`);
    await input('[aria-label="实例参数 card-rhythm/amplitude"]', '32');
    const edited = await render([255]);
    const nodes = edited.metadata[0].programEdit.nodes;
    assert(nodes.find((node: any) => node.id === 'card-rhythm').component.values.amplitude === 32 && nodes.find((node: any) => node.id === 'card-depth').component.values.amplitude === 24, 'instance parameters not independent');
    const state = await read();
    await client.tool('save_project', { expected_draft_revision: state.draftRevision, expected_disk_revision: state.diskRevision });
    const saved = await loadProject(root);
    assert(saved.scenes[0].layers[0].x === 650 && saved.scenes[1].program?.edits?.instances?.['card-rhythm'].parameters.amplitude.value === 32, 'editable changes did not persist');
    await waitFor(`document.querySelectorAll('.sequence-clip-images img').length >= 12 && !!document.querySelector('.sequence-audio-clip img')`, 'thumbnails and waveform');
    await js('document.querySelector(".project-trigger").click()');
    await js('Array.from(document.querySelectorAll(".project-popover [role=menuitem]")).find(element => element.textContent?.includes("打开新版示例工程")).click()');
    await waitFor(`document.querySelector('.project-trigger').title.includes('sample-project-new-')`, 'fresh project copy');
    const freshRoot = await js('document.querySelector(".project-trigger").title'), fresh = await loadProject(freshRoot);
    assert(fresh.manifest.id === 'aiscripter-default-motion' && fresh.scenes[0].layers[0].x === 620 && !fresh.scenes[1].program?.edits, 'fresh demo reused user modifications');
    assert((await loadProject(root)).scenes[0].layers[0].x === 650, 'fresh action overwrote edited default');
    await seek(75);
    await js('document.querySelector(".program-scene-entry").click()');
    await waitFor(`!!document.querySelector('[data-program-object="hero"]')`, 'new preview');
    return { startup: true, storyboard: true, allChaptersRendered: true, seamMapping: true, deterministic: true, previewIsolation: true,
      nativeTitleEditing: true, independentInstances: true, saveReopen: true, mediaStrip: true, freshCopy: true, editsPreserved: true,
      frameSha256: createHash('sha256').update(Buffer.from(frames.images[0].data, 'base64')).digest('hex'),
      frames: frames.metadata.map((frame: any) => ({ globalFrame: frame.globalFrame, sceneId: frame.sceneId, frame: frame.frame, milliseconds: frame.milliseconds, errors: frame.errors })) };
  } finally { client.close(); }
}
