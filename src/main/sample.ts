import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { revisionOf } from './project';
import { projectCopyFilter } from './project-copy';

const originalDemoRevision = 'e3123f26f56b97c49359d56b51162914d3820ce3d21d18f71be0851f969b636c';
const svgSizes = [
  { file: 'sun.svg', old: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">', size: 'width="600" height="600" ' },
  { file: 'earth.svg', old: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">', size: 'width="400" height="400" ' },
];

/** Managed demo copies refresh only when their visible files remain untouched. */
export async function prepareDefaultProject(userData: string, bundled: string): Promise<string> {
  await fs.mkdir(userData, { recursive: true });
  const directory = await fs.realpath(userData), target = path.join(directory, 'default-animation-project');
  const metadata = path.join(target, '.aiscripter', 'bundled-sample.json');
  let previous: { bundleRevision: string; copiedRevision: string } | undefined;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Default project must be a regular directory');
    try { previous = JSON.parse(await fs.readFile(metadata, 'utf8')); }
    catch { return target; }
    if (!previous || !/^[a-f0-9]{64}$/.test(previous.bundleRevision) || !/^[a-f0-9]{64}$/.test(previous.copiedRevision)) return target;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const bundleRevision = await revisionOf(bundled);
  if (previous && (previous.bundleRevision === bundleRevision || await revisionOf(target) !== previous.copiedRevision)) return target;
  const stage = await fs.mkdtemp(path.join(directory, 'default-animation-stage-'));
  try {
    await fs.cp(bundled, stage, { recursive: true, filter: projectCopyFilter(bundled) });
    const copiedRevision = await revisionOf(stage);
    if (copiedRevision !== bundleRevision) throw new Error('Bundled default project changed while copying');
    await fs.mkdir(path.join(stage, '.aiscripter'), { recursive: true });
    await fs.writeFile(path.join(stage, '.aiscripter', 'bundled-sample.json'), JSON.stringify({ bundleRevision, copiedRevision }), 'utf8');
    if (previous) {
      if (await revisionOf(target) !== previous.copiedRevision) return target;
      const backup = path.join(directory, `default-animation-before-refresh-${randomUUID()}`);
      await fs.rename(target, backup);
      try { await fs.rename(stage, target); }
      catch (error) { await fs.rename(backup, target); throw error; }
    } else await fs.rename(stage, target);
    return target;
  } finally {
    const relative = path.relative(directory, path.resolve(stage));
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(stage).startsWith('default-animation-stage-')) await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function prepareSampleProject(userData: string, bundled: string, pristineRevision = originalDemoRevision): Promise<string> {
  const target = path.join(userData, 'sample-project');
  try { await fs.access(path.join(target, 'project.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await fs.stat(target); throw new Error('Existing sample folder has no project.json'); }
    catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
    await fs.cp(bundled, target, { recursive: true, errorOnExist: true, filter: projectCopyFilter(bundled) });
    return target;
  }

  if (await revisionOf(target) === pristineRevision) {
    const backup = path.join(userData, `sample-project-before-refresh-${randomUUID()}`);
    await fs.cp(target, backup, { recursive: true, errorOnExist: true, filter: projectCopyFilter(target) });
    await fs.cp(bundled, target, { recursive: true, force: true, filter: projectCopyFilter(bundled) });
    return target;
  }

  const manifest = JSON.parse(await fs.readFile(path.join(target, 'project.json'), 'utf8')) as { id?: string };
  if (manifest.id !== 'solar-system-demo') return target;
  for (const item of svgSizes) {
    const file = path.join(target, 'assets', item.file);
    let source: string;
    try { source = await fs.readFile(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!source.startsWith(item.old)) continue;
    const backup = path.join(target, '.aiscripter-backups', `svg-repair-${item.file}-${randomUUID()}`);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(file, backup);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, source.replace(item.old, item.old.replace('viewBox=', `${item.size}viewBox=`)), 'utf8');
    await fs.rename(temporary, file);
  }
  return target;
}
