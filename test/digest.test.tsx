import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { DigestRow, NightDigest, RunStatus } from '../src/digest/types.js';

const night = '2026-10-28';
const firstAt = `${night}T01:00:00+05:30`;
const lastAt = `${night}T01:10:00+05:30`;

type Event = {
  at: string;
  job: string;
  status: RunStatus;
  owner: string | null;
  error?: string;
};

function event(job: string, overrides: Partial<Event> = {}): Event {
  return { at: firstAt, job, status: 'ok', owner: 'operator', ...overrides };
}

function row(job: string, overrides: Partial<DigestRow> = {}): DigestRow {
  return {
    job, owner: 'operator', runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
    firstAt, lastAt: firstAt, hadFailure: false, ...overrides,
  };
}

// Read cell text, allowing nested tags, arbitrary attributes and either quote style.
// Decode after stripping tags so escaped user input remains visible text.
function text(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (_, entity: string) => {
      if (entity.startsWith('#')) {
        return String.fromCodePoint(entity[1].toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10));
      }
      const entities: Record<string, string> = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      };
      return entities[entity.toLowerCase()];
    },
  ).replace(/\s+/g, ' ').trim();
}

function tableRows(html: string) {
  return [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi)].map(([markup]) => ({
    markup,
    cells: [...markup.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)]
      .map(([, contents]) => text(contents)),
  }));
}

function jobRow(html: string, job: string) {
  const matches = tableRows(html).filter(({ cells }) => cells.includes(job));
  expect(matches, `one table row for ${job}`).toHaveLength(1);
  return matches[0];
}

function hasWarning(markup: string): boolean {
  return /\bclass\s*=\s*["'][^"']*\bwarn\b[^"']*["']/i.test(markup);
}

describe('digest routes', () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-test-'));
  });

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  function writeNight(lines: (Event | string)[]) {
    writeFileSync(join(runsDir, `${night}.jsonl`), lines.map((line) =>
      typeof line === 'string' ? line : JSON.stringify(line)).join('\n'));
  }

  function app() {
    return createApp({ adapter: 'shim', installed: firstAt, beatEverySeconds: 60, runsDir });
  }

  async function getDigest() {
    const instance = app();
    const [page, api] = await Promise.all([
      instance.request(`/digest/${night}`),
      instance.request(`/api/digest/${night}`),
    ]);
    expect({ html: page.status, json: api.status }, 'digest response statuses')
      .toEqual({ html: 200, json: 200 });
    expect(page.headers.get('content-type')).toMatch(/text\/html/i);
    expect(api.headers.get('content-type')).toMatch(/application\/json/i);
    const digest: NightDigest = await api.json();
    return { html: await page.text(), digest };
  }

  it('serves a normal night as HTML and the complete NightDigest JSON shape', async () => {
    writeNight([
      event('backup', { status: 'retry', error: 'network unavailable' }),
      event('backup', { at: lastAt }),
      event('sync', { status: 'fail', error: 'access denied', owner: 'sync-team' }),
    ]);

    const { html, digest } = await getDigest();
    expect(digest).toEqual({
      night,
      rows: [
        row('backup', { runs: 2, retries: 1, lastError: 'network unavailable', lastAt }),
        row('sync', {
          owner: 'sync-team', lastStatus: 'fail', lastError: 'access denied', hadFailure: true,
        }),
      ],
      badLines: 0,
      counts: { ok: 1, retry: 1, fail: 1 },
    } satisfies NightDigest);
    expect(text(html)).toContain(night);
    expect(jobRow(html, 'backup').cells).toEqual(expect.arrayContaining([
      'operator', '2', '1', 'ok', 'network unavailable',
    ]));
    expect(jobRow(html, 'sync').cells).toEqual(expect.arrayContaining([
      'sync-team', 'fail', 'access denied',
    ]));
  });

  it.each(['/digest', '/api/digest'])('returns 404 for a missing night at %s', async (route) => {
    const response = await app().request(`${route}/${night}`);
    expect(response.status).toBe(404);
  });

  it('renders an empty existing night as nothing ran and returns an empty digest', async () => {
    writeNight([]);
    const { html, digest } = await getDigest();
    expect(text(html)).toMatch(/nothing ran/i);
    expect(digest).toEqual({
      night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 },
    } satisfies NightDigest);
  });

  it('counts a malformed line visibly and in JSON while retaining valid jobs on either side', async () => {
    writeNight([event('before'), '{not valid JSON', event('after')]);
    const { html, digest } = await getDigest();
    expect(digest).toEqual({
      night, rows: [row('after'), row('before')], badLines: 1,
      counts: { ok: 2, retry: 0, fail: 0 },
    } satisfies NightDigest);
    expect(text(html)).toMatch(/(?:\b1\s+(?:bad|malformed|invalid)\s+lines?\b|\b(?:bad|malformed|invalid)\s+lines?\s*[:=]?\s*1\b)/i);
    jobRow(html, 'before');
    jobRow(html, 'after');
  });

  it('retains a null-owner job in JSON and displays its missing owner as an em dash', async () => {
    writeNight([event('unowned', { owner: null })]);
    const { html, digest } = await getDigest();
    expect(digest.rows).toEqual([row('unowned', { owner: null })]);
    const header = tableRows(html).find(({ markup }) => /<th\b/i.test(markup));
    const ownerColumn = header?.cells.findIndex((cell) => /^owner$/i.test(cell)) ?? -1;
    expect(ownerColumn, 'owner column exists').toBeGreaterThanOrEqual(0);
    expect(jobRow(html, 'unowned').cells[ownerColumn]).toBe('—');
  });

  it('sorts jobs identically in HTML and JSON regardless of log order', async () => {
    writeNight([event('zebra'), event('alpha'), event('middle'), event('zebra', { at: lastAt })]);
    const { html, digest } = await getDigest();
    const jobs = digest.rows.map(({ job }) => job);
    expect(jobs).toEqual(['alpha', 'middle', 'zebra']);
    const htmlJobs = tableRows(html).flatMap(({ cells }) => cells.filter((cell) => jobs.includes(cell)));
    expect(htmlJobs).toEqual(jobs);
    expect(digest.rows[2]).toEqual(row('zebra', { runs: 2, lastAt }));
  });

  it('escapes user-controlled job, owner and error text in HTML and preserves it in JSON', async () => {
    const job = '<script>alert("job")</script>';
    const owner = '<img src=x onerror="alert(1)"> & owner';
    const error = '<svg onload="alert(2)">failure</svg> & "quoted"';
    writeNight([event(job, { owner, status: 'fail', error })]);
    const { html, digest } = await getDigest();
    expect(digest.rows).toEqual([row(job, {
      owner, lastStatus: 'fail', lastError: error, hadFailure: true,
    })]);
    expect(jobRow(html, job).cells).toEqual(expect.arrayContaining([job, owner, error]));
    for (const value of [job, owner, error]) expect(html).not.toContain(value);
    expect(html).not.toMatch(/<(?:script|img|svg)\b/i);
  });

  it('keeps the original timestamp offsets in both representations', async () => {
    const start = `${night}T01:00:00-03:30`;
    const end = `${night}T10:25:00+05:45`;
    writeNight([event('offsets', { at: start }), event('offsets', { at: end })]);
    const { html, digest } = await getDigest();
    expect(digest.rows).toEqual([row('offsets', { runs: 2, firstAt: start, lastAt: end })]);
    const visibleRow = text(jobRow(html, 'offsets').markup);
    expect(visibleRow).toContain(start);
    expect(visibleRow).toContain(end);
  });

  it('warns at three retries and for any failure, including a failure followed by recovery', async () => {
    writeNight([
      event('two-retries', { status: 'retry' }),
      event('two-retries', { status: 'retry' }),
      event('three-retries', { status: 'retry' }),
      event('three-retries', { status: 'retry' }),
      event('three-retries', { status: 'retry' }),
      event('failed', { status: 'fail', error: 'still broken' }),
      event('recovered', { status: 'fail', error: 'earlier failure' }),
      event('recovered', { at: lastAt }),
      event('healthy'),
    ]);
    const { html, digest } = await getDigest();
    expect(digest.rows).toEqual([
      row('failed', { lastStatus: 'fail', lastError: 'still broken', hadFailure: true }),
      row('healthy'),
      row('recovered', { runs: 2, lastError: 'earlier failure', lastAt, hadFailure: true }),
      row('three-retries', { runs: 3, retries: 3, lastStatus: 'retry' }),
      row('two-retries', { runs: 2, retries: 2, lastStatus: 'retry' }),
    ]);
    expect(digest.counts).toEqual({ ok: 2, retry: 5, fail: 2 });
    for (const job of ['three-retries', 'failed', 'recovered']) {
      expect(hasWarning(jobRow(html, job).markup), `${job} should warn`).toBe(true);
    }
    for (const job of ['two-retries', 'healthy']) {
      expect(hasWarning(jobRow(html, job).markup), `${job} should not warn`).toBe(false);
    }
  });
});
