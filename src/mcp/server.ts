import { promises as fs } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { checkProject } from '../main/project';
import { creationClient } from './creation-tools';
import { bundledContentRoot } from '../main/content';

const appRoot = bundledContentRoot(path.resolve(__dirname, '..'));
const argumentIndex = process.argv.indexOf('--project');
const projectRoot = argumentIndex >= 0 && process.argv[argumentIndex + 1]
  ? path.resolve(process.argv[argumentIndex + 1]) : undefined;

const documents = {
  index: 'docs/README.md',
  ai_workflow: 'docs/external-ai-workflow.zh-CN.md',
  format_v2: 'docs/project-format-v2.zh-CN.md',
  format_v3: 'docs/project-format-v3.zh-CN.md',
  program_editing: 'docs/ai-creation-phase-3.zh-CN.md',
  sdk: 'src/sdk/index.ts',
  project_schema_v3: 'schema/project-v3.schema.json',
  scene_schema_v3: 'schema/scene-v3.schema.json',
  format_v1: 'docs/project-format-v1.md',
  project_schema_v2: 'schema/project.schema.json',
  project_schema_v1: 'schema/project-v1.schema.json',
  scene_schema: 'schema/scene.schema.json',
  mcp: 'docs/mcp-local.zh-CN.md',
} as const;

const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const failed = (error: unknown) => ({ content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true });
const requireRoot = (): string => {
  if (!projectRoot) throw new Error('Start this MCP server with --project <project-folder> to use project tools. Documentation tools remain available without a project.');
  return projectRoot;
};

function createServer(): McpServer {
  const server = new McpServer({ name: 'aiscripter-for-ani', version: '0.4.0' });
  const creation = creationClient(requireRoot, process.argv.includes('--offline'));
  creation.register(server);

  server.registerTool('read_documentation', {
    description: 'Read the authoritative AIScripter project contract, external AI workflow, or JSON Schemas before creating or changing a project.',
    inputSchema: z.object({ section: z.enum(Object.keys(documents) as [keyof typeof documents, ...(keyof typeof documents)[]]) }),
  }, async ({ section }) => {
    try {
      const file = documents[section];
      return result({ section, file, text: await fs.readFile(path.join(appRoot, file), 'utf8') });
    } catch (error) { return failed(error); }
  });

  server.registerTool('inspect_project', {
    description: 'Read current editor draft or explicitly identified disk state, including full scenes, unsaved scripts and revisions.',
    inputSchema: z.object({}),
  }, async () => {
    try {
      const { project, ...state } = await creation.session();
      return result({ ...project, ...state });
    } catch (error) { return failed(error); }
  });

  server.registerTool('read_project_file', {
    description: 'Read current draft project/scene JSON or script; text assets come from project disk. Binary media and external paths are unavailable.',
    inputSchema: z.object({ relative_path: z.string().min(1) }),
  }, async ({ relative_path }) => {
    try {
      return result(await creation.readFile(relative_path));
    } catch (error) { return failed(error); }
  });

  server.registerTool('validate_project', {
    description: 'Validate the current draft and project resources. Reports structural errors, missing resources, warnings and revisions.',
    inputSchema: z.object({ strict_resources: z.boolean().default(false) }),
  }, async ({ strict_resources }) => {
    try {
      const { project, ...state } = await creation.session();
      const report = await checkProject(project);
      const resourceWarnings = report.warnings.filter(warning => !warning.includes('extends beyond video end'));
      return result({ root: project.root, revision: project.revision, ...state, valid: report.ok && (!strict_resources || resourceWarnings.length === 0), ...report });
    } catch (error) { return failed(error); }
  });

  return server;
}

void serveStdio(createServer);
