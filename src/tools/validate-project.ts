import path from 'node:path';
import { checkProject, loadProject } from '../main/project';
import { buildPrograms } from '../main/program-build';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const strictAssets = args.includes('--strict-assets');
  const positional = args.filter(arg => !arg.startsWith('--'));
  const target = positional[0];
  if (positional.length !== 1 || args.some(arg => arg.startsWith('--') && !['--strict-assets', '--build'].includes(arg))) {
    console.error('Usage: npm run validate:project -- <project-folder|project.json> [--strict-assets] [--build]');
    process.exitCode = 2;
    return;
  }

  const root = path.resolve(path.basename(target).toLowerCase() === 'project.json' ? path.dirname(target) : target);
  try {
    const project = await loadProject(root);
    const report = await checkProject(project);
    if (args.includes('--build')) for (const diagnostic of (await buildPrograms(project)).diagnostics) report.errors.push(`${diagnostic.path || 'program'}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column}` : ''}: ${diagnostic.message}`);
    report.ok = report.errors.length === 0;
    const frames = project.scenes.reduce((sum, scene) => sum + (scene.clip ? scene.clip.outFrame - scene.clip.inFrame : scene.durationFrames), 0);
    console.log(`${project.manifest.name} | format v${project.manifest.formatVersion} | ${project.scenes.length} scene(s) | ${frames} frame(s) @ ${project.manifest.fps} fps`);
    for (const error of report.errors) console.error(`ERROR ${error}`);
    for (const warning of report.warnings) console.warn(`WARN  ${warning}`);
    console.log(report.ok ? 'Structure valid.' : 'Structure invalid.');
    const resourceWarnings = report.warnings.filter(warning => !warning.includes('extends beyond video end'));
    if (!report.ok || (strictAssets && resourceWarnings.length)) process.exitCode = 1;
  } catch (error) {
    console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

void main();
