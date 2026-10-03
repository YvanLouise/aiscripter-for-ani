import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'dist-tools', 'aiscripter-mcp.cjs');

async function smoke(protocolVersion, withProject = true, writeTest = false, programTest = false) {
  const copy = writeTest ? await fs.mkdtemp(path.join(os.tmpdir(), 'ani-mcp-smoke-')) : undefined;
  if (copy) await fs.cp(path.join(root, 'examples', programTest ? 'program-scenes' : 'sequence-v2'), copy, { recursive: true });
  const child = spawn(process.execPath, [executable, ...(withProject ? ['--project', copy || path.join(root, 'examples', 'sequence-v2')] : []), ...(writeTest ? ['--offline'] : [])], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const timer = setTimeout(() => { for (const complete of pending.values()) complete({ error: { message: 'MCP smoke timeout' } }); pending.clear(); child.kill(); }, 10000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const call = (method, params = {}) => new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const initialized = await call('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'aiscripter-smoke', version: '1.0' } });
    if (initialized.error) throw new Error(JSON.stringify(initialized.error));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await call('tools/list');
    const names = listed.result.tools.map(tool => tool.name);
    for (const name of ['read_documentation', 'inspect_project', 'read_project_file', 'validate_project', 'get_session', 'stage_changes', 'commit_changes', 'render_frames', 'export_preview', 'get_diagnostics', 'import_assets', 'undo_offline_commit', 'build_project']) {
      if (!names.includes(name)) throw new Error(`Missing MCP tool: ${name}`);
    }
    const document = await call('tools/call', { name: 'read_documentation', arguments: { section: 'format_v2' } });
    if (!document.result.content[0].text.includes('工程格式 v2')) throw new Error('Documentation was not returned');
    if (!withProject) {
      const unavailable = await call('tools/call', { name: 'inspect_project', arguments: {} });
      if (!unavailable.result.isError) throw new Error('Project tool should require --project');
      console.log(`${protocolVersion}: documentation available without a project`);
      return;
    }
    const inspected = await call('tools/call', { name: 'inspect_project', arguments: {} });
    const project = JSON.parse(inspected.result.content[0].text);
    if (project.scenes.length !== 2 || !project.revision) throw new Error('Project inspection failed');
    if (programTest) {
      const sdk = await call('tools/call', { name: 'read_documentation', arguments: { section: 'sdk' } });
      if (!JSON.parse(sdk.result.content[0].text).text.includes('defineScene')) throw new Error('SDK contract missing');
      const build = await call('tools/call', { name: 'build_project', arguments: { draft_revision: project.draftRevision } });
      const report = JSON.parse(build.result.content[0].text);
      if (!report.ok || !report.programs.program.path) throw new Error(`Program build failed: ${JSON.stringify(report)}`);
      const component = await call('tools/call', { name: 'read_project_file', arguments: { relative_path: 'components/card.ts' } });
      if (!JSON.parse(component.result.content[0].text).text.includes('spring')) throw new Error('Component source missing');
    }
    const checked = await call('tools/call', { name: 'validate_project', arguments: { strict_resources: true } });
    if (!JSON.parse(checked.result.content[0].text).valid) throw new Error('Project validation failed');
    const forbidden = await call('tools/call', { name: 'read_project_file', arguments: { relative_path: '../package.json' } });
    if (!forbidden.result.isError) throw new Error('Path traversal was not rejected');
    if (writeTest) {
      const fields = { expected_draft_revision: project.draftRevision, expected_disk_revision: project.diskRevision };
      const staged = await call('tools/call', { name: 'stage_changes', arguments: { ...fields, changes: [{ kind: 'update_project', patch: { name: 'MCP offline edit' } }] } });
      const stage = JSON.parse(staged.result.content[0].text);
      const committed = await call('tools/call', { name: 'commit_changes', arguments: { stage_id: stage.id } });
      const saved = JSON.parse(committed.result.content[0].text);
      if (saved.project.manifest.name !== 'MCP offline edit' || !saved.undoId) throw new Error('Offline commit failed');
      const stale = await call('tools/call', { name: 'stage_changes', arguments: { ...fields, changes: [{ kind: 'update_project', patch: { name: 'Stale' } }] } });
      if (!stale.result.isError) throw new Error('Stale revision was accepted');
      const undone = await call('tools/call', { name: 'undo_offline_commit', arguments: { undo_id: saved.undoId, expected_draft_revision: saved.draftRevision, expected_disk_revision: saved.diskRevision } });
      if (JSON.parse(undone.result.content[0].text).project.manifest.name !== project.manifest.name) throw new Error('Offline undo failed');
      console.log(`${protocolVersion}: offline stage/commit, stale revision rejection and durable undo passed`);
    }
    console.log(`${protocolVersion}: ${names.length} tools, 2 scenes, valid project, traversal rejected`);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
    if (copy) await fs.rm(copy, { recursive: true, force: true });
  }
}

await smoke('2025-06-18');
await smoke('2026-07-28');
await smoke('2026-07-28', false);
await smoke('2026-07-28', true, true);
await smoke('2026-07-28', true, true, true);
