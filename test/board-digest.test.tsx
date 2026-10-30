import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readNight } from '../src/digest/reader.js';
import type { NightDigest, ReadNight } from '../src/digest/types.js';
import { readStatus } from '../src/status.js';

// The reader is supplied by #1 at integration; this suite tests its board contract.
vi.mock('../src/digest/reader.js', () => ({ readNight: vi.fn<ReadNight>() }));

const reader = vi.mocked<ReadNight>(readNight);
let runsDir: string;
const config = () => ({
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
  runsDir,
});

function digest(night: string, counts: NightDigest['counts']): NightDigest {
  return { night, rows: [], badLines: 1, counts };
}

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-board-'));
  reader.mockReset();
  reader.mockReturnValue(null);
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('status board digest links', () => {
  it('links each disk night newest first with the reader’s valid-event counts', async () => {
    writeFileSync(join(runsDir, '2026-10-27.jsonl'), '');
    writeFileSync(join(runsDir, '2026-10-28.jsonl'), '');
    writeFileSync(join(runsDir, 'notes.txt'), '');
    reader.mockImplementation((dir, night) => {
      expect(dir).toBe(runsDir);
      return digest(night, night === '2026-10-28'
        ? { ok: 10, retry: 4, fail: 1 }
        : { ok: 7, retry: 0, fail: 0 });
    });

    const res = await createApp(config()).request('/');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<a href="/digest/2026-10-28">2026-10-28</a> · ok 10 / retry 4 / fail 1');
    expect(html).toContain('<a href="/digest/2026-10-27">2026-10-27</a> · ok 7 / retry 0 / fail 0');
    expect(html.indexOf('/digest/2026-10-28')).toBeLessThan(html.indexOf('/digest/2026-10-27'));
    expect(reader).toHaveBeenCalledTimes(2);
    expect(html).not.toContain('notes.txt');
  });

  it('exposes matching night/count pairs through readStatus', () => {
    writeFileSync(join(runsDir, '2026-10-28.jsonl'), '');
    const counts = { ok: 10, retry: 4, fail: 1 };
    reader.mockReturnValue(digest('2026-10-28', counts));

    expect(readStatus(config()).nights).toEqual([{ night: '2026-10-28', counts }]);
  });

  it('keeps an empty night linked with zero counts', async () => {
    writeFileSync(join(runsDir, '2026-10-29.jsonl'), '');
    reader.mockReturnValue(digest('2026-10-29', { ok: 0, retry: 0, fail: 0 }));

    const html = await (await createApp(config()).request('/')).text();

    expect(html).toContain('<a href="/digest/2026-10-29">2026-10-29</a> · ok 0 / retry 0 / fail 0');
  });

  it('keeps a discovered night visible if its digest is no longer available', async () => {
    writeFileSync(join(runsDir, '2026-10-28.jsonl'), '');

    const html = await (await createApp(config()).request('/')).text();

    expect(html).toContain('<a href="/digest/2026-10-28">2026-10-28</a> · ok — / retry — / fail —');
  });

  it.each(['empty', 'missing'])('preserves the no-nights message for an %s directory', async (kind) => {
    if (kind === 'missing') rmSync(runsDir, { recursive: true });

    const res = await createApp(config()).request('/');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('nothing in runs/');
    expect(reader).not.toHaveBeenCalled();
  });

  it('preserves board metadata, the lane banner, and health', async () => {
    vi.stubEnv('LANE_MARKER', 'BOARD-DIGEST-TEST');
    const app = createApp(config());
    const html = await (await app.request('/')).text();

    expect(html).toContain('BOARD-DIGEST-TEST');
    expect(html).toContain('<th>adapter</th><td>shim</td>');
    expect(html).toContain('<th>installed</th><td>2026-10-29T14:06:00+01:00</td>');
    expect(html).toContain('last beat');
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, lane: 'lane-07' });
  });
});
