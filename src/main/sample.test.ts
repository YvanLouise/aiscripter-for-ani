import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { revisionOf } from './project';
import { prepareDefaultProject, prepareSampleProject } from './sample';

const bundled = path.join(process.cwd(), 'examples', 'solar-system');

describe('bundled sample refresh', () => {
  it('replaces a pristine older copy after backing it up', async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-sample-'));
    try {
      const target = path.join(userData, 'sample-project');
      await fs.cp(bundled, target, { recursive: true });
      await fs.writeFile(path.join(target, 'assets', 'orbit-guide.svg'), '<svg width="10" height="10"/>');
      const pristine = await revisionOf(target);
      await prepareSampleProject(userData, bundled, pristine);
      const backups = (await fs.readdir(userData)).filter(name => name.startsWith('sample-project-before-refresh-'));
      expect(backups).toHaveLength(1);
      expect(await revisionOf(path.join(userData, backups[0]))).toBe(pristine);
      expect(await revisionOf(target)).toBe(await revisionOf(bundled));
    } finally { await fs.rm(userData, { recursive: true, force: true }); }
  });

  it('keeps scene edits while repairing legacy SVG dimensions', async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-sample-'));
    try {
      const target = path.join(userData, 'sample-project');
      await fs.cp(bundled, target, { recursive: true });
      const sceneFile = path.join(target, 'scenes', 'introduction.json');
      const scene = JSON.parse(await fs.readFile(sceneFile, 'utf8'));
      scene.layers.find((layer: { id: string }) => layer.id === 'intro-title').x = 1080;
      await fs.writeFile(sceneFile, JSON.stringify(scene));
      const svgFile = path.join(target, 'assets', 'sun.svg');
      await fs.writeFile(svgFile, (await fs.readFile(svgFile, 'utf8')).replace(' width="600" height="600"', ''));
      await prepareSampleProject(userData, bundled);
      expect(JSON.parse(await fs.readFile(sceneFile, 'utf8')).layers.find((layer: { id: string }) => layer.id === 'intro-title').x).toBe(1080);
      expect(await fs.readFile(svgFile, 'utf8')).toContain('width="600" height="600"');
      expect((await fs.readdir(path.join(target, '.aiscripter-backups'))).some(name => name.startsWith('svg-repair-sun.svg-'))).toBe(true);
    } finally { await fs.rm(userData, { recursive: true, force: true }); }
  });
});

describe('dedicated default animation', () => {
  it('uses a separate managed copy and backs up pristine versions on refresh', async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-default-'));
    try {
      const source = path.join(userData, 'bundle');
      await fs.cp(path.join(process.cwd(), 'examples/default-animation'), source, { recursive: true });
      await fs.mkdir(path.join(userData, 'sample-project'));
      await fs.writeFile(path.join(userData, 'sample-project', 'human.txt'), 'old demo edits');
      const target = await prepareDefaultProject(userData, source), pristine = await revisionOf(target);
      expect(target).not.toBe(source);
      expect(pristine).toBe(await revisionOf(source));
      await fs.writeFile(path.join(source, 'assets', 'cards.json'), '[]');
      expect(await prepareDefaultProject(userData, source)).toBe(target);
      expect(await revisionOf(target)).toBe(await revisionOf(source));
      const backups = (await fs.readdir(userData)).filter(name => name.startsWith('default-animation-before-refresh-'));
      expect(backups).toHaveLength(1);
      expect(await revisionOf(path.join(userData, backups[0]))).toBe(pristine);
      expect(await fs.readFile(path.join(userData, 'sample-project', 'human.txt'), 'utf8')).toBe('old demo edits');
      await prepareDefaultProject(userData, source);
      expect((await fs.readdir(userData)).filter(name => name.startsWith('default-animation-before-refresh-'))).toHaveLength(1);
    } finally { await fs.rm(userData, { recursive: true, force: true }); }
  });

  it('preserves user changes when a newer default is bundled', async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'aiscripter-default-'));
    try {
      const source = path.join(userData, 'bundle');
      await fs.cp(path.join(process.cwd(), 'examples/default-animation'), source, { recursive: true });
      const target = await prepareDefaultProject(userData, source);
      await fs.writeFile(path.join(target, 'assets', 'cards.json'), '["human change"]');
      const edited = await revisionOf(target);
      await fs.writeFile(path.join(source, 'assets', 'cards.json'), '[]');
      expect(await prepareDefaultProject(userData, source)).toBe(target);
      expect(await revisionOf(target)).toBe(edited);
      expect((await fs.readdir(userData)).some(name => name.startsWith('default-animation-before-refresh-'))).toBe(false);
      expect((await fs.readdir(userData)).some(name => name.startsWith('default-animation-stage-'))).toBe(false);
    } finally { await fs.rm(userData, { recursive: true, force: true }); }
  });
});
