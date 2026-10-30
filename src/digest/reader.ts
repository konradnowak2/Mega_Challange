import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, NightDigest, ReadNight, RunStatus } from './types.js';

type RunEvent = {
  at: string;
  job: string;
  status: RunStatus;
  owner: string | null;
  error?: string;
};

type JobState = {
  row: DigestRow;
  first: number;
  last: number;
  errorAt: number;
};

function validNight(night: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) return false;
  const time = Date.parse(`${night}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === night;
}

function validTimestamp(at: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(at)
    && validNight(at.slice(0, 10))
    && Number.isFinite(Date.parse(at));
}

function parseEvent(line: string): RunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('at' in value) || typeof value.at !== 'string' || !validTimestamp(value.at)) return null;
  if (!('job' in value) || typeof value.job !== 'string' || value.job.trim() === '') return null;
  if (!('status' in value) || (value.status !== 'ok' && value.status !== 'retry' && value.status !== 'fail')) return null;
  if (!('owner' in value) || (value.owner !== null && typeof value.owner !== 'string')) return null;
  if ('error' in value && typeof value.error !== 'string') return null;
  const error = 'error' in value && typeof value.error === 'string' ? value.error : undefined;
  return {
    at: value.at,
    job: value.job,
    status: value.status,
    owner: value.owner,
    ...(error !== undefined ? { error } : {}),
  };
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!validNight(night)) return null;
  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }

  const digest: NightDigest = { night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } };
  const jobs = new Map<string, JobState>();
  const lines = contents.split(/\r?\n/);
  // A final newline terminates the preceding record; it isn't another record.
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const event = parseEvent(line);
    if (event === null) {
      digest.badLines++;
      continue;
    }
    digest.counts[event.status]++;
    const time = Date.parse(event.at);
    let state = jobs.get(event.job);
    if (!state) {
      state = {
        row: {
          job: event.job, owner: event.owner, runs: 0, retries: 0,
          lastStatus: event.status, lastError: null,
          firstAt: event.at, lastAt: event.at, hadFailure: false,
        },
        first: time, last: time, errorAt: -Infinity,
      };
      jobs.set(event.job, state);
    }
    const row = state.row;
    row.runs++;
    if (event.status === 'retry') row.retries++;
    if (event.status === 'fail') row.hadFailure = true;
    if (time < state.first) {
      state.first = time;
      row.firstAt = event.at;
    }
    // At equal instants the later record wins, consistently for owner/status/error.
    if (time >= state.last) {
      state.last = time;
      row.lastAt = event.at;
      row.lastStatus = event.status;
      row.owner = event.owner;
    }
    if (event.error !== undefined && time >= state.errorAt) {
      state.errorAt = time;
      row.lastError = event.error;
    }
  }
  digest.rows = [...jobs.values()].map(({ row }) => row)
    .sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return digest;
};
