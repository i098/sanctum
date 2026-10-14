import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { costUsd } from '../scripts/soak/drive.ts';
import { manifestSource } from '../scripts/soak/source.ts';
import { isSpeech, readWav, wavFile } from '../scripts/soak/wav.ts';

test('a 24 h schedule with 960 speech minutes and the Aura-2 audio build stays under the $15 hard stop', () => {
  const day = { speech_seconds: 960 * 60, run_seconds: 86_400, chunk_puts: 2880 };
  assert.ok(costUsd(day, 1.85) < 15);
  assert.ok(costUsd({ ...day, speech_seconds: 1440 * 60 }, 1.85) > 12);
  assert.ok(costUsd({ ...day, speech_seconds: 2_200 * 60 }, 1.85) >= 15, 'a runaway speech total must cross the stop');
});

test('silence below the -56 dBFS gate is not billed as speech', () => {
  assert.equal(isSpeech(new Int16Array(1600).fill(20)), false);
  assert.equal(isSpeech(new Int16Array(1600).fill(200)), true);
});

test('wavFile output is read back by readWav, including a streamed header with a zero data length', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soak-wav-'));
  try {
    const samples = Int16Array.from({ length: 480 }, (_, i) => i - 240);
    const bytes = wavFile(samples, 24_000);
    assert.equal(bytes.byteLength, 44 + 960);
    writeFileSync(join(dir, 'a.wav'), bytes);
    const streamed = Buffer.from(bytes);
    streamed.writeUInt32LE(0, 40);
    writeFileSync(join(dir, 'b.wav'), streamed);
    for (const name of ['a.wav', 'b.wav']) {
      const file = await open(join(dir, name));
      assert.deepEqual(await readWav(file), { sample_rate: 24_000, data_offset: 44, samples: 480 });
      await file.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest meetings play at their slot start, with silence in the gap and in unbuilt slots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'soak-manifest-'));
  try {
    mkdirSync(join(dir, 'audio'));
    writeFileSync(join(dir, 'audio', 'm00.wav'), wavFile(Int16Array.from([1, 2, 3, 4]), 8_000));
    writeFileSync(join(dir, 'audio', 'm02.wav'), wavFile(Int16Array.from([7, 8]), 8_000));
    const slot = (index: number, audio: string | null) => ({ start_s: index * 0.001, end_s: (index + 1) * 0.001, audio: audio === null ? null : { file: audio } });
    const manifest = { sample_rate: 8_000, schedule: [slot(0, 'audio/m00.wav'), slot(1, null), slot(2, 'audio/m02.wav')] };
    const source = await manifestSource(join(dir, 'manifest.json'), manifest);
    assert.equal(source.samples, 24);
    assert.deepEqual([...(await source.read(2, 20))], [3, 4, ...Array(12).fill(0), 7, 8, 0, 0, 0, 0]);
    await source.close();
    await assert.rejects(manifestSource(join(dir, 'manifest.json'), { ...manifest, schedule: [{ start_s: 0, end_s: 0.0003, audio: { file: 'audio/m00.wav' } }] }), /longer than its slot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
