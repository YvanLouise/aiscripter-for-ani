import { build } from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildDiagnostic, LoadedProject } from '../shared/types';
import { validateSources } from './project';

const sdkFile = [path.join(__dirname, '../src/sdk/index.ts'), path.join(__dirname, '../sdk/index.ts')].find(file => existsSync(file));
if (!sdkFile) throw new Error('Bundled animation SDK source is missing');
const sdkSource = readFileSync(sdkFile, 'utf8');
const virtualRoot = '/__ani__/';
const sdkPath = `${virtualRoot}sdk.ts`;
const cache = new Map<string, Promise<ProgramBuild>>();
export type ProgramBuild = { programs: NonNullable<LoadedProject['programs']>; sources: Record<string, string>; diagnostics: BuildDiagnostic[] };

function resolveModule(specifier: string, importer: string, sources: Record<string, string>): string {
  if (specifier === '@aiscripter/sdk') return sdkPath;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(`Unsupported import: ${specifier}. Only @aiscripter/sdk and relative project modules are available`);
  if (specifier.includes('\\') || specifier.includes('?') || specifier.includes('#')) throw new Error(`Invalid module path: ${specifier}`);
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(importer.replace(virtualRoot, '')), specifier));
  if (!/^(scripts|components)\//.test(relative) || relative.split('/').some(part => part.startsWith('.'))) throw new Error(`Module escapes source directories: ${specifier}`);
  const candidates = [relative, `${relative}.ts`, `${relative}.mjs`, `${relative}/index.ts`, `${relative}/index.mjs`];
  const found = candidates.find(candidate => Object.hasOwn(sources, candidate));
  if (!found) throw new Error(`Missing project module: ${relative}`);
  return `${virtualRoot}${found}`;
}

function typeCheck(entries: string[], sources: Record<string, string>): BuildDiagnostic[] {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, allowJs: true, noEmit: true,
    skipLibCheck: true, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], allowImportingTsExtensions: true };
  const appRoot = path.resolve(__dirname, '..');
  const base = ts.createCompilerHost(options), libDirectory = (appRoot.endsWith('.asar')
    ? path.join(path.dirname(appRoot), 'compiler/typescript/lib') : path.dirname(ts.getDefaultLibFilePath(options))).replaceAll('\\', '/');
  const normalize = (name: string) => name.replaceAll('\\', '/');
  const read = (name: string): string | undefined => {
    name = normalize(name);
    if (name === sdkPath) return sdkSource;
    if (name.startsWith(virtualRoot)) return Object.hasOwn(sources, name.slice(virtualRoot.length)) ? sources[name.slice(virtualRoot.length)] : undefined;
    if (path.posix.dirname(name) === libDirectory && /^lib\.[a-z0-9.]+\.d\.ts$/.test(path.posix.basename(name))) return base.readFile(name);
    return undefined;
  };
  const host: ts.CompilerHost = { ...base, getCurrentDirectory: () => virtualRoot, useCaseSensitiveFileNames: () => true, getCanonicalFileName: normalize,
    getDefaultLibLocation: () => libDirectory, getDefaultLibFileName: () => `${libDirectory}/lib.es2022.full.d.ts`,
    fileExists: name => read(name) !== undefined, readFile: read,
    getSourceFile: (name, language) => { const text = read(name); return text === undefined ? undefined : ts.createSourceFile(name, text, language, true); },
    resolveModuleNames: (names, containing) => names.map(name => {
      try { const resolvedFileName = resolveModule(name, normalize(containing), sources); return { resolvedFileName, extension: resolvedFileName.endsWith('.mjs') ? ts.Extension.Mjs : ts.Extension.Ts }; }
      catch { return undefined; }
    }), writeFile: () => undefined,
  };
  const program = ts.createProgram(entries.map(entry => virtualRoot + entry), options, host);
  const diagnostics: BuildDiagnostic[] = ts.getPreEmitDiagnostics(program).slice(0, 50).map(diagnostic => {
    const location = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
    return { path: diagnostic.file?.fileName.replace(virtualRoot, ''), line: location ? location.line + 1 : undefined,
      column: location ? location.character + 1 : undefined, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') };
  });
  for (const file of program.getSourceFiles().filter(file => file.fileName.startsWith(virtualRoot) && file.fileName !== sdkPath)) {
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ((node.expression.kind === ts.SyntaxKind.ImportKeyword && (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))) || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const position = file.getLineAndCharacterOfPosition(node.getStart());
        diagnostics.push({ path: file.fileName.replace(virtualRoot, ''), line: position.line + 1, column: position.character + 1, message: 'Computed imports and require() are unavailable in program scenes' });
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return diagnostics.slice(0, 50);
}

export async function buildPrograms(project: LoadedProject): Promise<ProgramBuild> {
  validateSources(project.root, project.sources, project.manifest.formatVersion);
  const entries = [...new Set(project.scenes.flatMap(scene => scene.program ? [scene.program.entry] : []))].sort();
  if (!entries.length) return { programs: {}, sources: {}, diagnostics: [] };
  if (project.manifest.formatVersion !== 3) throw new Error('Program scenes require format v3');
  const sources = { ...project.sources };
  const key = createHash('sha256').update(JSON.stringify([sdkSource, sources, entries])).digest('hex');
  let pending = cache.get(key);
  if (!pending) {
    pending = compile(entries, sources);
    cache.set(key, pending);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
  }
  const compiled = await pending;
  return { ...compiled, programs: Object.fromEntries(project.scenes.filter(scene => scene.program).map(scene => [scene.id, compiled.programs[scene.program!.entry]])) };
}

async function compile(entries: string[], sources: Record<string, string>): Promise<ProgramBuild> {
  const result: ProgramBuild = { programs: {}, sources: {}, diagnostics: [] };
  for (const entry of entries) {
    const hash = createHash('sha256').update(JSON.stringify([entry, sdkSource, sources])).digest('hex');
    let diagnostics = typeCheck([entry], sources);
    let output: string | undefined;
    if (!diagnostics.length) {
      try {
        const built = await build({ entryPoints: [virtualRoot + entry], bundle: true, write: false, platform: 'browser', format: 'esm',
          target: 'chrome120', sourcemap: 'inline', sourcesContent: true, logLevel: 'silent', tsconfigRaw: {}, plugins: [{ name: 'ani-project-modules', setup(api) {
            api.onResolve({ filter: /.*/ }, args => {
              try {
                const resolved = args.kind === 'entry-point' ? args.path : resolveModule(args.path, args.importer, sources);
                return { path: resolved, namespace: 'ani-project' };
              } catch (error) { return { errors: [{ text: String(error) }] }; }
            });
            api.onLoad({ filter: /.*/, namespace: 'ani-project' }, args => {
              const contents = args.path === sdkPath ? sdkSource : sources[args.path.replace(virtualRoot, '')];
              if (contents === undefined) return { errors: [{ text: `Missing module: ${args.path}` }] };
              return { contents, loader: args.path.endsWith('.mjs') ? 'js' : 'ts' };
            });
          } }] });
        output = built.outputFiles[0].text;
        if (Buffer.byteLength(output) > 16 * 1024 * 1024) throw new Error('Compiled program exceeds 16 MB');
      } catch (error) {
        const errors = (error as { errors?: { text: string; location?: { file: string; line: number; column: number } }[] }).errors;
        diagnostics = errors?.map(item => ({ message: item.text, path: item.location?.file, line: item.location?.line, column: item.location ? item.location.column + 1 : undefined })) || [{ path: entry, message: String(error) }];
      }
    }
    const bundlePath = `scripts/__compiled_${hash}.mjs`;
    result.programs[entry] = { hash, path: output ? bundlePath : undefined, diagnostics };
    if (output) result.sources[bundlePath] = output;
    result.diagnostics.push(...diagnostics);
  }
  return result;
}
