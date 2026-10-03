import { promises as fs } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { offlineService, importAsset } from '../main/ai-service';
import { callBridge, readBridge } from '../main/ai-bridge';
import { checkProject, realProjectFile, safeRelative } from '../main/project';
import type { AiChange, AiSession } from '../shared/ai-service';
import { buildPrograms } from '../main/program-build';

export const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
export const failed = (error: unknown) => ({ content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true });

export function creationClient(requireRoot: () => string, offline: boolean) {
  let diskService: ReturnType<typeof offlineService> | undefined;
  async function editorMode(): Promise<boolean> {
    const descriptor = await readBridge(requireRoot());
    if (!descriptor) return false;
    if (!offline) return true;
    try { process.kill(descriptor.pid, 0); throw new Error('EDITOR_ACTIVE: omit --offline to edit the open draft'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    return false;
  }
  async function session(): Promise<AiSession> {
    if (await editorMode()) return await callBridge(requireRoot(), { method: 'session' }) as AiSession;
    return (diskService ||= offlineService(requireRoot())).read();
  }
  async function invoke(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (await editorMode()) {
      if (method === 'undo') throw new Error('EDITOR_ACTIVE: use editor undo for open drafts');
      return callBridge(requireRoot(), { method, args });
    }
    if (!offline) throw new Error('EDITOR_UNAVAILABLE: open this project, or explicitly start with --offline for disk writes');
    const disk = diskService ||= offlineService(requireRoot());
    switch (method) {
      case 'build': {
        const state = await disk.read();
        if (state.draftRevision !== args.draftRevision) throw new Error('REVISION_CONFLICT: inspect again');
        const built = await buildPrograms(state.project);
        return { draftRevision: state.draftRevision, ok: !built.diagnostics.length, programs: built.programs, diagnostics: built.diagnostics };
      }
      case 'stage': return disk.service.stage(String(args.expectedDraftRevision), String(args.expectedDiskRevision), args.changes as AiChange[]);
      case 'commit': return disk.service.commit(String(args.id));
      case 'discard': disk.service.discard(String(args.id)); return { discarded: true };
      case 'undo': return disk.undo(String(args.id), String(args.expectedDraftRevision), String(args.expectedDiskRevision));
      case 'import': {
        const state = await disk.read();
        if (state.draftRevision !== args.expectedDraftRevision || state.diskRevision !== args.expectedDiskRevision) throw new Error('REVISION_CONFLICT: inspect again');
        return { relativePath: args.relativePath, revision: await importAsset(requireRoot(), state.diskRevision, String(args.relativePath), String(args.base64)) };
      }
      default: throw new Error('EDITOR_REQUIRED: rendering, preview jobs and draft saving require an open editor');
    }
  }
  async function readFile(relative: string): Promise<unknown> {
    const state = await session(), project = state.project;
    safeRelative(project.root, relative);
    if (!/^(?:project\.json|scenes\/[A-Za-z0-9_-]+\.json|(?:scripts|components)\/[A-Za-z0-9_./-]+\.(?:mjs|ts)|assets\/[A-Za-z0-9_./-]+\.(?:json|svg|txt|md))$/.test(relative)) throw new Error('Only project JSON, source modules and text assets can be read');
    let text: string;
    if (relative === 'project.json') text = JSON.stringify({ ...project.manifest, scenes: project.scenes.map(scene => ({ id: scene.id, file: `scenes/${scene.id}.json` })) }, null, 2);
    else if (relative.startsWith('scenes/')) {
      const scene = project.scenes.find(value => `scenes/${value.id}.json` === relative || project.manifest.scenes.find(ref => ref.id === value.id)?.file === relative);
      if (!scene) throw new Error('Scene file not present in current draft');
      text = JSON.stringify(scene, null, 2);
    } else if (Object.hasOwn(project.sources || {}, relative)) text = project.sources![relative];
    else {
      const file = await realProjectFile(project.root, relative);
      if ((await fs.stat(file)).size > 1048576) throw new Error('Text file exceeds 1 MB');
      text = await fs.readFile(file, 'utf8');
    }
    if (Buffer.byteLength(text) > 1048576) throw new Error('Text file exceeds 1 MB');
    return { relative_path: relative, text, mode: state.mode, draftRevision: state.draftRevision, diskRevision: state.diskRevision };
  }

  function register(server: McpServer): void {
    const revisions = { expected_draft_revision: z.string().min(1), expected_disk_revision: z.string().min(1) };
    server.registerTool('get_capabilities', { description: 'Read implemented formats, session modes, edit operations and rendering limits.', inputSchema: z.object({}) }, async () => result({
      formats: [1, 2, 3], programmableScenesV3: true, sdk: '1.1.0', supportedSdkVersions: ['1.0.0', '1.1.0'], programRenderers: ['2d', 'webgl2'], modules: ['.ts', '.mjs', '@aiscripter/sdk'], modes: ['editor-draft', 'explicit-offline'],
      programEditing: { objectTree: true, transformedBounds: true, publicParameters: true, componentInstances: true, humanOverrides: 'preserved-and-protected', keyframes: ['linear', 'smooth', 'hold'], feedback: 'render_frames.frames[].programEdit', locks: 'shared script edits rejected while any program override is locked' },
      changes: ['update_layer', 'add_layer', 'remove_layer', 'update_scene', 'add_scene', 'remove_scene', 'reorder_scenes', 'update_project', 'write_script', 'enable_programs'],
      offlineUndo: true,
      screenshot: { editorRequired: true, maxFrames: 6, maxWidth: 1920, maxHeight: 1080 }, preview: { editorRequired: true, maxSeconds: 30, width: 960, height: 540, maxPendingJobs: 4 },
      stageExpirySeconds: 600, scriptLimitBytes: 1048576, assetImportLimitBytes: 8388608,
    }));
    server.registerTool('build_project', {
      description: 'Type-check and bundle v3 program scenes in the current draft or offline project. Returns file/line diagnostics without executing project code.',
      inputSchema: z.object({ draft_revision: z.string().min(1) }),
    }, async args => { try {
      const state = await session();
      if (state.draftRevision !== args.draft_revision) throw new Error('REVISION_CONFLICT: inspect again');
      if (await editorMode()) return result(await invoke('build', { draftRevision: args.draft_revision }));
      const built = await buildPrograms(state.project);
      return result({ draftRevision: state.draftRevision, ok: !built.diagnostics.length, programs: built.programs, diagnostics: built.diagnostics });
    } catch (error) { return failed(error); } });
    server.registerTool('get_session', { description: 'Read current draft/disk revisions, unsaved status, mode and playhead. An unavailable editor session never falls back silently to disk.', inputSchema: z.object({}) }, async () => {
      try { const { project, ...state } = await session(); return result({ ...state, root: project.root, baselineRevision: project.revision }); } catch (error) { return failed(error); }
    });
    server.registerTool('stage_changes', {
      description: 'Stage ID-based changes without mutation. patch is shallow; send full keyframes/params maps. value supplies a new layer/scene. write_script uses path/source. Program edits are human-owned: omitted edits are preserved, replacing/deleting edits is rejected. Locked objects, parameters and layers protect shared script edits.',
      inputSchema: z.object({ ...revisions, changes: z.array(z.object({
        kind: z.enum(['update_layer', 'add_layer', 'remove_layer', 'update_scene', 'add_scene', 'remove_scene', 'reorder_scenes', 'update_project', 'write_script', 'enable_programs']),
        sceneId: z.string().optional(), layerId: z.string().optional(), patch: z.record(z.string(), z.unknown()).optional(), value: z.unknown().optional(), order: z.array(z.string()).optional(), path: z.string().optional(), source: z.string().max(1048576).optional(),
      })).min(1).max(100) }),
    }, async input => {
      try { return result(await invoke('stage', { expectedDraftRevision: input.expected_draft_revision, expectedDiskRevision: input.expected_disk_revision, changes: input.changes })); } catch (error) { return failed(error); }
    });
    for (const [name, method] of [['commit_changes', 'commit'], ['discard_changes', 'discard']] as const) server.registerTool(name, { description: method === 'commit' ? 'Commit a validated stage after revision checks. Creates one editor undo record; offline mode persists a journaled transaction.' : 'Discard a pending stage.', inputSchema: z.object({ stage_id: z.string() }) }, async ({ stage_id }) => {
      try { return result(await invoke(method, { id: stage_id })); } catch (error) { return failed(error); }
    });
    server.registerTool('save_project', { description: 'Persist the current editor draft using exact draft/disk revisions and the normal save path.', inputSchema: z.object(revisions) }, async input => {
      try { return result(await invoke('save', { expectedDraftRevision: input.expected_draft_revision, expectedDiskRevision: input.expected_disk_revision })); } catch (error) { return failed(error); }
    });
    server.registerTool('undo_offline_commit', { description: 'Restore the pre-commit project snapshot returned as undoId by an offline commit. Requires --offline and current revisions. Returns another undoId that can restore the undone revision.', inputSchema: z.object({ ...revisions, undo_id: z.string() }) }, async input => {
      try { return result(await invoke('undo', { id: input.undo_id, expectedDraftRevision: input.expected_draft_revision, expectedDiskRevision: input.expected_disk_revision })); } catch (error) { return failed(error); }
    });
    server.registerTool('import_assets', { description: 'Import one NEW base64 asset under assets/ (max 8 MB), update the baseline, then stage references. Cannot overwrite existing files; unreferenced bytes are retained after undo.', inputSchema: z.object({ ...revisions, relative_path: z.string(), base64: z.string().max(11184812) }) }, async input => {
      try { return result(await invoke('import', { expectedDraftRevision: input.expected_draft_revision, expectedDiskRevision: input.expected_disk_revision, relativePath: input.relative_path, base64: input.base64 })); } catch (error) { return failed(error); }
    });
    server.registerTool('render_frames', { description: 'Render global integer frames of an immutable draft in a hidden renderer. Returns PNG images, mapping, per-layer errors and timing; visible preview/playhead stay unchanged.', inputSchema: z.object({ draft_revision: z.string(), frames: z.array(z.number().int().min(0)).min(1).max(6), width: z.number().int().min(16).max(1920).default(960), height: z.number().int().min(16).max(1080).default(540) }) }, async input => {
      try {
        const rendered = await invoke('render', { draftRevision: input.draft_revision, frames: input.frames, width: input.width, height: input.height }) as { frames: ({ png?: string } & Record<string, unknown>)[] };
        const images = rendered.frames.filter(frame => frame.png).map(frame => ({ type: 'image' as const, mimeType: 'image/png' as const, data: frame.png!.split(',')[1] }));
        return { content: [...result({ ...rendered, frames: rendered.frames.map(({ png: _png, ...frame }) => frame) }).content, ...images] };
      } catch (error) { return failed(error); }
    });
    server.registerTool('get_diagnostics', { description: 'Read current structural/resource checks and runtime diagnostics from the last render of this draft.', inputSchema: z.object({}) }, async () => {
      try {
        if (await editorMode()) return result(await callBridge(requireRoot(), { method: 'diagnostics' }));
        const state = await session(); return result({ draftRevision: state.draftRevision, check: await checkProject(state.project), build: (await buildPrograms(state.project)).diagnostics, runtime: null, mode: state.mode });
      } catch (error) { return failed(error); }
    });
    server.registerTool('export_preview', { description: 'Queue an immutable 960x540 H.264/AAC MP4 preview up to 30 seconds. Global range is [start_frame,end_frame). Returns a job ID; poll get_job.', inputSchema: z.object({ draft_revision: z.string(), start_frame: z.number().int().min(0), end_frame: z.number().int().min(1) }) }, async input => {
      try { return result(await invoke('export', { draftRevision: input.draft_revision, startFrame: input.start_frame, endFrame: input.end_frame })); } catch (error) { return failed(error); }
    });
    for (const [name, method] of [['get_job', 'job'], ['cancel_job', 'cancel']] as const) server.registerTool(name, { description: method === 'job' ? 'Read preview job state, progress, output path and error.' : 'Cancel a queued or running preview job.', inputSchema: z.object({ job_id: z.string() }) }, async ({ job_id }) => {
      try { return result(await invoke(method, { id: job_id })); } catch (error) { return failed(error); }
    });
  }
  return { session, readFile, register };
}
