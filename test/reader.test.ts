import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';
import type { ReadNight } from '../src/digest/types.js';

const fixtures = fileURLToPath(new URL('../runs/', import.meta.url));
const night = '2026-10-28';
const directories: string[] = [];

function tempNight(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'rig-reader-'));
  directories.push(directory);
  writeFileSync(join(directory, `${night}.jsonl`), contents);
  return directory;
}

const event = {
  at: '2026-10-29T01:00:00+01:00', job: 'example/run', status: 'ok', owner: 'rook',
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('readNight', () => {
  it('reads the real night: five sorted jobs, all event counts, and one bad line', () => {
    const reader: ReadNight = readNight;
    expect(reader(fixtures, night)).toEqual({
      night,
      badLines: 1,
      counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        {
          job: 'digest/render', owner: null, runs: 1, retries: 0,
          lastStatus: 'ok', lastError: null, hadFailure: false,
          firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00',
        },
        {
          job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3,
          lastStatus: 'ok', lastError: 'upstream 503', hadFailure: false,
          firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00',
        },
        {
          job: 'lane/sync', owner: 'rook', runs: 8, retries: 1,
          lastStatus: 'ok', lastError: 'lock held', hadFailure: false,
          firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00',
        },
        {
          job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0,
          lastStatus: 'fail', lastError: 'quota exceeded', hadFailure: true,
          firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00',
        },
        {
          job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0,
          lastStatus: 'ok', lastError: null, hadFailure: false,
          firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00',
        },
      ],
    });
  });

  it('uses instants across offsets, retains the latest error, and remembers recovered failures', () => {
    const events = [
      { ...event, at: '2026-10-29T01:30:00-02:00', owner: null },
      { ...event, at: '2026-10-29T04:00:00+01:00', status: 'retry', error: 'latest error' },
      { ...event, at: '2026-10-29T02:00:00+02:00', status: 'fail', error: 'old error' },
      { ...event, at: '2026-10-29T02:00:00Z', status: 'retry' },
    ];
    const digest = readNight(tempNight(events.map((value) => JSON.stringify(value)).join('\r\n') + '\r\n'), night);
    expect(digest).toEqual({
      night, badLines: 0, counts: { ok: 1, retry: 2, fail: 1 },
      rows: [{
        job: event.job, owner: null, runs: 4, retries: 2,
        lastStatus: 'ok', lastError: 'latest error', hadFailure: true,
        firstAt: '2026-10-29T02:00:00+02:00', lastAt: '2026-10-29T01:30:00-02:00',
      }],
    });
  });

  it('validates JSON fields and timestamps before counting events, continuing after each bad line', () => {
    const { owner: _owner, ...missingOwner } = event;
    const invalid = [
      null, [], 'text', 42, true, {}, missingOwner,
      { ...event, at: 123 }, { ...event, at: '2026-02-30T01:00:00Z' },
      { ...event, at: '2026-10-29' }, { ...event, at: '2026-10-29T01:00:00' },
      { ...event, at: '2026-10-29T24:00:00Z' }, { ...event, at: '2026-10-29T01:60:00Z' },
      { ...event, at: '2026-10-29T01:00:00+25:00' },
      { ...event, job: null }, { ...event, job: '  ' },
      { ...event, status: 'unknown' }, { ...event, owner: 42 },
      { ...event, error: null }, { ...event, error: {} },
    ].map((value) => JSON.stringify(value));
    invalid.push('{broken', '', '   ');
    const contents = [JSON.stringify(event), ...invalid, JSON.stringify({ ...event, owner: null })].join('\n');
    expect(readNight(tempNight(contents), night)).toEqual({
      night, badLines: invalid.length, counts: { ok: 2, retry: 0, fail: 0 },
      rows: [{
        job: event.job, owner: null, runs: 2, retries: 0,
        lastStatus: 'ok', lastError: null, hadFailure: false,
        firstAt: event.at, lastAt: event.at,
      }],
    });
  });

  it('keeps equal-instant updates deterministic and accepts fractional timestamps and empty reported errors', () => {
    const events = [
      { ...event, at: '2026-10-29T01:00:00.123+01:00', status: 'retry', error: 'first' },
      { ...event, at: '2026-10-29T00:00:00.123Z', status: 'fail', error: '' },
    ];
    const digest = readNight(tempNight(events.map((value) => JSON.stringify(value)).join('\n')), night);
    expect(digest?.rows[0]).toEqual({
      job: event.job, owner: 'rook', runs: 2, retries: 1,
      lastStatus: 'fail', lastError: '', hadFailure: true,
      firstAt: events[0].at, lastAt: events[1].at,
    });
  });

  it('returns an empty digest for an empty file, and counts an entirely malformed file', () => {
    expect(readNight(tempNight(''), night)).toEqual({
      night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 },
    });
    expect(readNight(tempNight('not json\nnull\n'), night)).toEqual({
      night, rows: [], badLines: 2, counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('returns null for missing nights, missing directories, and non-directory paths', () => {
    const directory = tempNight('');
    expect(readNight(directory, '2026-10-27')).toBeNull();
    expect(readNight(join(directory, 'missing'), night)).toBeNull();
    expect(readNight(join(directory, `${night}.jsonl`), night)).toBeNull();
  });

  it.each(['../2026-10-28', '2026-1-01', '2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-10-00', '2026-10-32', '2026-10-28.jsonl', ''])('rejects invalid night %j even if a matching file exists', (invalidNight) => {
    const directory = tempNight('');
    if (/^[\d-]+$/.test(invalidNight)) writeFileSync(join(directory, `${invalidNight}.jsonl`), JSON.stringify(event));
    expect(readNight(directory, invalidNight)).toBeNull();
  });

  it('accepts a real leap day', () => {
    const directory = tempNight('');
    writeFileSync(join(directory, '2024-02-29.jsonl'), JSON.stringify({ ...event, at: '2024-02-29T23:59:59Z' }));
    expect(readNight(directory, '2024-02-29')?.rows).toHaveLength(1);
  });
});
