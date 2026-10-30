export type RunStatus = 'ok' | 'retry' | 'fail';

export type DigestRow = {
  job: string;
  owner: string | null;
  runs: number;
  retries: number;
  lastStatus: RunStatus;
  lastError: string | null;
  firstAt: string;
  lastAt: string;
  hadFailure: boolean;
};

export type NightDigest = {
  night: string;
  rows: DigestRow[];
  badLines: number;
  counts: Record<RunStatus, number>;
};

// null means the night does not exist (including invalid YYYY-MM-DD names).
// Rows are sorted by job; counts cover valid log events, not just final statuses.
// Display timestamps retain their original offsets. lastError retains the last
// reported error even if a later successful event has no error field.
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
