import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const repository = new URL(meta.repository.url).pathname.replace(/^\//, '').replace(/\.git$/, '');
const owner = repository.split('/')[0];
let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  const credential = execFileSync('git', ['-c', 'credential.interactive=never', 'credential', 'fill'], {
    input: `protocol=https\nhost=github.com\nusername=${owner}\n\n`, encoding: 'utf8', env: { ...process.env, GCM_INTERACTIVE: 'never' }, windowsHide: true,
  });
  token = credential.split('\n').find(line => line.startsWith('password='))?.slice(9).trim();
}
if (!token) throw new Error('GitHub authentication required; sign in with Git Credential Manager or gh auth login. Never commit access tokens.');
const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'AIScripter-release', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(route, options = {}) {
  const response = await fetch(`https://api.github.com${route}`, { headers: { ...headers, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${data.message}`);
  return data;
}
const [command, argument] = process.argv.slice(2);
if (command === 'create') {
  const account = await api('/user');
  if (account.login.toLowerCase() !== owner.toLowerCase()) throw new Error('Authenticated account differs from repository owner');
  const probe = await fetch(`https://api.github.com/repos/${repository}`, { headers });
  if (probe.status !== 404) throw new Error('Repository already exists or is inaccessible; inspect it before publishing');
  const repo = await api('/user/repos', { method: 'POST', body: JSON.stringify({ name: repository.split('/')[1], description: meta.description, private: false, auto_init: false, has_issues: true, has_projects: false, has_wiki: false }) });
  console.log(repo.html_url);
} else if (command === 'dispatch') {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${argument || 'ffmpeg-build.yml'}/dispatches`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' }) });
  if (response.status !== 204) throw new Error(`Workflow dispatch failed: HTTP ${response.status}`);
  console.log('Workflow dispatched.');
} else if (command === 'runs') {
  const result = await api(`/repos/${repository}/actions/runs?per_page=8`);
  console.log(JSON.stringify(result.workflow_runs.map(run => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url })), null, 2));
} else if (command === 'jobs') {
  const result = await api(`/repos/${repository}/actions/runs/${argument}/jobs`);
  console.log(JSON.stringify(result.jobs.map(job => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, steps: job.steps.map(step => ({ name: step.name, status: step.status, conclusion: step.conclusion })) })), null, 2));
} else if (command === 'artifacts') {
  const result = await api(`/repos/${repository}/actions/runs/${argument}/artifacts`);
  console.log(JSON.stringify(result.artifacts.map(item => ({ name: item.name, size: item.size_in_bytes, digest: item.digest })), null, 2));
} else if (command === 'logs') {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/jobs/${argument}/logs`, { headers, redirect: 'manual' });
  if (response.status !== 302) throw new Error(`Logs unavailable: HTTP ${response.status}`);
  const logs = await fetch(response.headers.get('location'));
  const text = await logs.text();
  console.log(text.slice(-16000));
} else if (command === 'download') {
  const result = await api(`/repos/${repository}/actions/runs/${argument}/artifacts`);
  const artifact = result.artifacts.find(item => item.name === 'ffmpeg-win64' && !item.expired);
  if (!artifact) throw new Error('Completed ffmpeg-win64 artifact is required');
  const response = await fetch(artifact.archive_download_url, { headers, redirect: 'manual' });
  if (response.status !== 302) throw new Error(`Artifact download failed: HTTP ${response.status}`);
  const destination = path.join(root, '.build/ffmpeg-workflow.zip');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const size = artifact.size_in_bytes, chunkSize = Math.ceil(size / 8);
  const parts = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const start = index * chunkSize, end = Math.min(size - 1, start + chunkSize - 1), file = destination + `.part${index}`;
    try {
      await promisify(execFile)(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--silent', '--show-error', '--retry', '3', '--retry-all-errors', '--max-time', '900', '--range', `${start}-${end}`, '--output', file, response.headers.get('location')], { windowsHide: true, timeout: 1800000 });
    } catch { throw new Error(`Artifact download part ${index} failed; rerun download.`); }
    const bytes = await fs.readFile(file);
    if (bytes.length !== end - start + 1) throw new Error(`Artifact range ${index} has incorrect length`);
    console.log(`Downloaded part ${index + 1}/8`);
    return bytes;
  }));
  const archive = Buffer.concat(parts);
  if (artifact.digest && `sha256:${createHash('sha256').update(archive).digest('hex')}` !== artifact.digest) throw new Error('GitHub artifact digest mismatch');
  await fs.writeFile(destination, archive);
  for (let index = 0; index < 8; index++) await fs.unlink(destination + `.part${index}`);
  console.log(destination);
} else if (command === 'publish') {
  const tag = `v${meta.version}`, notes = await fs.readFile(path.join(root, 'docs/release-notes.md'), 'utf8');
  const files = [`AIScripter-for-ani-${meta.version}-x64-Setup.exe`, 'third-party-sources.tar.gz', 'SHA256SUMS.txt'];
  for (const file of files) if ((await fs.stat(path.join(root, 'release', file))).size === 0) throw new Error(`Empty release asset: ${file}`);
  const checksums = await fs.readFile(path.join(root, 'release/SHA256SUMS.txt'), 'utf8');
  for (const file of files.slice(0, 2)) {
    const digest = createHash('sha256').update(await fs.readFile(path.join(root, 'release', file))).digest('hex');
    if (!checksums.includes(`${digest}  ${file}\n`)) throw new Error(`Release checksum mismatch: ${file}`);
  }
  await api(`/repos/${repository}/git/ref/tags/${tag}`);
  const release = await api(`/repos/${repository}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: tag, name: `AIScripter for ani ${meta.version}`, body: notes, draft: true, prerelease: true, target_commitish: 'main' }) });
  for (const file of files) {
    const bytes = await fs.readFile(path.join(root, 'release', file));
    const response = await fetch(`${release.upload_url.replace(/\{.*$/, '')}?name=${encodeURIComponent(file)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes });
    if (!response.ok) throw new Error(`Release upload ${file}: HTTP ${response.status}`);
    console.log(`Uploaded ${file}`);
  }
  const published = await api(`/repos/${repository}/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false }) });
  console.log(published.html_url);
} else if (command === 'verify') {
  const repo = await api(`/repos/${repository}`), release = await api(`/repos/${repository}/releases/tags/v${meta.version}`);
  console.log(JSON.stringify({ repository: repo.html_url, private: repo.private, license: repo.license?.spdx_id, release: release.html_url, draft: release.draft, assets: release.assets.map(asset => ({ name: asset.name, size: asset.size, digest: asset.digest, url: asset.browser_download_url })) }, null, 2));
} else throw new Error('Commands: create, dispatch, runs, jobs <run-id>, artifacts <run-id>, logs <job-id>, download <run-id>, publish, verify');
