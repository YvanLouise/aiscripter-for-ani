import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'examples/default-animation/assets');
await fs.mkdir(assets, { recursive: true });
await fs.copyFile(path.join(root, 'AIS-icon.png'), path.join(assets, 'brand-icon.png'));

const rate = 44100, seconds = 18, samples = rate * seconds;
const chords = [[50, 57, 62, 66, 69], [47, 54, 59, 62, 66], [43, 50, 55, 59, 62]];
const melody = [[74, 69, 66, 76, 74, 69, 78, 76, 74, 69], [71, 66, 62, 74, 71, 66, 76, 74, 71, 66], [67, 62, 59, 71, 67, 62, 74, 71, 67, 62]];
const frequency = note => 440 * 2 ** ((note - 69) / 12);
const attack = (time, duration) => Math.min(1, Math.max(0, time / duration));
function signal(time, channel) {
  const section = Math.min(2, Math.floor(time / 6)), local = time - section * 6;
  const gain = attack(local, 0.7) * attack(6 - local, 0.75);
  let value = 0;
  chords[section].forEach((note, i) => {
    const phase = (time + channel * 0.003) * frequency(note) * Math.PI * 2;
    value += (Math.sin(phase * (1 + channel * 0.00045)) + Math.sin(phase * 2) * 0.12) * gain * (i === 0 ? 0.055 : 0.026);
  });
  const beat = Math.floor(time / 0.6);
  for (let prior = 0; prior < 3; prior++) {
    const index = beat - prior, age = time - index * 0.6 - channel * 0.012;
    if (index < 0 || age < 0) continue;
    const note = melody[Math.min(2, Math.floor(index / 10))][index % 10], phase = age * frequency(note) * Math.PI * 2;
    value += (Math.sin(phase) + Math.sin(phase * 2) * 0.18 + Math.sin(phase * 3) * 0.05) * attack(age, 0.015) * Math.exp(-age * 3.6) * 0.07;
  }
  return Math.tanh(value) * attack(time, 0.45) * attack(seconds - time, 1.25);
}
const pcm = Buffer.alloc(samples * 4), header = Buffer.alloc(44);
for (let i = 0; i < samples; i++) for (let channel = 0; channel < 2; channel++) pcm.writeInt16LE(Math.round(signal(i / rate, channel) * 32767), i * 4 + channel * 2);
header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
await fs.writeFile(path.join(assets, 'first-light.wav'), Buffer.concat([header, pcm]));
console.log('Default demo assets: supplied brand icon + original 18-second stereo First Light score.');
