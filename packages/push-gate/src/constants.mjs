// The fixed facts the push gate works from (docs/plans/push-gate.md).
// These are not settings: the gate writes to one repo, as one app.

export const APP_ID = '5665711';
export const INSTALLATION_ID = '179798275';
export const APP_NAME = 'Cloudwork Agents';
export const APP_LOGIN = 'cloudwork-agents[bot]';
export const OWNER = 'CloudworkSystems';
export const REPO = 'open-convo';
export const FULL_NAME = `${OWNER}/${REPO}`;
export const API_BASE = 'https://api.github.com';
export const GIT_URL = `https://github.com/${FULL_NAME}.git`;

export const AGENTS = { claude: 'Claude', codex: 'Codex', grokbot: 'GrokBot' };
export const REPORT_ISSUE = 52;

const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const LIMITS = {
  pushGapMs: 10 * MINUTE, // one push per pull request every 10 minutes
  writesPerHour: 60, // all agents together
  rateLimitPauseMs: HOUR, // the least a rate-limit stop lasts
  refusalsBeforeStop: 3, // other refusals in an hour that stop every write
  quietStartHour: 23, // 11 PM New York time
  quietEndHour: 6, // 6 AM New York time
  timeZone: 'America/New_York',
  bundleBytes: 50 * 1024 * 1024,
  textChars: 60000,
  requestBytes: 256 * 1024,
  logDays: 30,
};
