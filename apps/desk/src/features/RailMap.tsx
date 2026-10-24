import { useMemo, useState, type CSSProperties } from 'react';
import source from '../content/rail-map.json';
import {
  indexPulls, layoutRails, pullSpan, pullsForCommit, summarizeRails, validateRailMapSnapshot,
  type RailMapSnapshot, type RailPull, type RailPullIndex, type RailRow,
} from '../domain/rail-map';
import './rail-map.css';

type RailView = 'graph' | 'pulls' | 'branches';
const views: { id: RailView; label: string }[] = [
  { id: 'graph', label: 'Commit graph' }, { id: 'pulls', label: 'Pull requests' }, { id: 'branches', label: 'Branches' },
];
const ROW = 30, DAY = 28, LANE = 14, PAD = 12, FIRST_ROWS = 150;
const LANE_COLORS = 10;

function readSnapshot(): RailMapSnapshot | null {
  try { return validateRailMapSnapshot(source); } catch { return null; }
}
const snapshot = readSnapshot();

const laneColor = (lane: number) => lane === 0 ? 'var(--rail-main)' : `var(--rail-${((lane - 1) % LANE_COLORS) + 1})`;
const dayLabel = (value: string | number) => new Date(value).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const shortDay = (value: string | number) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const timeLabel = (value: string) => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const pullUrl = (repository: string, number: number) => `https://github.com/${repository}/pull/${number}`;

export function RailMap() {
  const [view, setView] = useState<RailView>('graph');
  if (!snapshot) return <section className="nexus-railmap" aria-label="Rail Map">
    <p className="rail-warning" role="alert">The Rail Map snapshot could not be read. Rebuild it with scripts/rail-map-snapshot.mjs.</p>
  </section>;
  const summary = summarizeRails(snapshot);
  return <section className="nexus-railmap" aria-label="Rail Map">
    <div className="nexus-view-intro rail-intro">
      <span className="eyebrow">CLOUDWORK RAIL MAP · {snapshot.repository} · SNAPSHOT {dayLabel(snapshot.takenAt).toUpperCase()}, {timeLabel(snapshot.takenAt)}</span>
      <h2>Every branch is a track.</h2>
      <p>Commits run newest first, merges join the main line, and each pull request shows where it stands.</p>
    </div>
    <dl className="rail-stats">
      <div className="rail-stat open"><dt>Open pull requests</dt><dd>{summary.openPulls}</dd></div>
      <div className="rail-stat"><dt>Merged in the last 7 days</dt><dd>{summary.mergedLastWeek}</dd></div>
      <div className="rail-stat"><dt>Branches with unmerged work</dt><dd>{summary.branchesWithWork}</dd></div>
      <div className="rail-stat"><dt>Commits shown</dt><dd>{summary.commits}</dd></div>
    </dl>
    <div className="rail-tabs" role="tablist" aria-label="Rail Map views">
      {views.map((item) => <button key={item.id} type="button" role="tab" id={`rail-tab-${item.id}`} aria-selected={view === item.id} aria-controls={`rail-panel-${item.id}`}
        tabIndex={view === item.id ? 0 : -1} className={view === item.id ? 'selected' : ''} onClick={() => setView(item.id)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          const at = views.findIndex((entry) => entry.id === view);
          const next = views[(at + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length];
          setView(next.id);
          document.getElementById(`rail-tab-${next.id}`)?.focus();
        }}>{item.label}</button>)}
    </div>
    <div role="tabpanel" id={`rail-panel-${view}`} aria-labelledby={`rail-tab-${view}`} className="rail-panel">
      {view === 'graph' && <CommitGraph snapshot={snapshot} />}
      {view === 'pulls' && <PullTimeline snapshot={snapshot} />}
      {view === 'branches' && <BranchTable snapshot={snapshot} />}
    </div>
    <p className="rail-footnote">A snapshot of the repository, not a live view. Refresh it with <code>node scripts/rail-map-snapshot.mjs</code> in apps/desk.</p>
  </section>;
}

function PullBadges({ pulls, repository }: { pulls: RailPull[]; repository: string }) {
  return <>{pulls.map((pull) => <span key={pull.number} className="rail-badges">
    <a className={`rail-pill pull-${pull.state}`} href={pullUrl(repository, pull.number)} target="_blank" rel="noreferrer" title={pull.title}>#{pull.number} {pull.state}</a>
    {pull.agent && <span className="rail-pill rail-agent">{pull.agent}</span>}
  </span>)}</>;
}

function CommitGraph({ snapshot }: { snapshot: RailMapSnapshot }) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => layoutRails(snapshot), [snapshot]);
  const pulls = useMemo(() => indexPulls(snapshot.pulls), [snapshot]);
  const needle = query.trim().toLowerCase();
  const filtered = needle ? rows.filter(({ commit }) => `${commit.subject} ${commit.hash} ${commit.refs.join(' ')}`.toLowerCase().includes(needle)) : null;
  const shown = filtered ?? (showAll ? rows : rows.slice(0, FIRST_ROWS));
  return <>
    <div className="rail-toolbar">
      <label className="sr-only" htmlFor="rail-filter">Filter commits</label>
      <input id="rail-filter" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by message, branch or hash" />
      <ul className="rail-legend" aria-label="Legend">
        <li><i style={{ background: 'var(--rail-main)' }} />main</li>
        <li><i style={{ background: 'var(--rail-open)' }} />open</li>
        <li><i style={{ background: 'var(--rail-merged)' }} />merged</li>
        <li><i style={{ background: 'var(--rail-closed)' }} />closed</li>
      </ul>
    </div>
    <div className="rail-graph">
      {filtered
        ? filtered.length ? <div className="rail-rows" style={{ '--rail-gutter': `${PAD}px` } as CSSProperties}>
          {filtered.slice(0, 300).map((row) => <CommitRow key={row.commit.hash} row={row} pulls={pulls} snapshot={snapshot} />)}
        </div> : <p className="rail-empty">No commits match “{query.trim()}”.</p>
        : <Tracks rows={shown} pulls={pulls} snapshot={snapshot} />}
    </div>
    {!filtered && !showAll && rows.length > FIRST_ROWS && <div className="rail-more">
      <button type="button" className="secondary-button" onClick={() => setShowAll(true)}>Show older commits ({rows.length - FIRST_ROWS} more)</button>
    </div>}
  </>;
}

function Tracks({ rows, pulls, snapshot }: { rows: RailRow[]; pulls: RailPullIndex; snapshot: RailMapSnapshot }) {
  const widest = rows.reduce((max, row) => Math.max(max, row.lane, ...row.segments.flatMap((segment) => [segment.from, segment.to])), 0);
  const gutter = PAD * 2 + widest * LANE + 4;
  const x = (lane: number) => PAD + lane * LANE;
  const items: { day?: string; row?: RailRow; y: number }[] = [];
  let y = 0, lastDay = '';
  for (const row of rows) {
    const day = new Date(row.commit.date).toDateString();
    if (day !== lastDay) { items.push({ day: row.commit.date, y }); y += DAY; lastDay = day; }
    items.push({ row, y: y + ROW / 2 });
    y += ROW;
  }
  const centers = items.flatMap((item) => item.row ? [item.y] : []);
  return <div className="rail-rows" style={{ '--rail-gutter': `${gutter}px` } as CSSProperties}>
    <svg className="rail-svg" width={gutter} height={y} viewBox={`0 0 ${gutter} ${y}`} aria-hidden="true">
      {rows.map((row, index) => {
        const y0 = centers[index], y1 = centers[index + 1] ?? y0 + ROW;
        return row.segments.map((segment, part) => {
          const x0 = x(segment.from), x1 = x(segment.to);
          const bend = y0 + Math.min(ROW, y1 - y0) * .8;
          const d = x0 === x1 ? `M${x0},${y0}L${x1},${y1}` : `M${x0},${y0}C${x0},${bend} ${x1},${y0 + 4} ${x1},${bend}L${x1},${y1}`;
          return <path key={`${row.commit.hash}-${part}`} d={d} stroke={laneColor(Math.max(segment.from, segment.to))} />;
        });
      })}
      {rows.map((row, index) => row.merge
        ? <circle key={row.commit.hash} className="rail-merge-dot" cx={x(row.lane)} cy={centers[index]} r={5} stroke={laneColor(row.lane)} />
        : <circle key={row.commit.hash} className="rail-dot" cx={x(row.lane)} cy={centers[index]} r={4} fill={laneColor(row.lane)} />)}
    </svg>
    {items.map((item) => item.day
      ? <div key={`day-${item.y}`} className="rail-day">{dayLabel(item.day)}</div>
      : <CommitRow key={item.row!.commit.hash} row={item.row!} pulls={pulls} snapshot={snapshot} />)}
  </div>;
}

function CommitRow({ row, pulls, snapshot }: { row: RailRow; pulls: RailPullIndex; snapshot: RailMapSnapshot }) {
  const { commit } = row;
  const linked = pullsForCommit(commit, pulls, snapshot.mainBranch);
  const merged = commit.mergedPull === undefined ? undefined : pulls.byNumber.get(commit.mergedPull);
  return <div className={`rail-row${row.onMain ? ' on-main' : ''}`} title={commit.subject}>
    <span className="rail-row-gutter" />
    <div className="rail-row-message">
      <code className="rail-hash">{commit.hash.slice(0, 7)}</code>
      {commit.refs.map((ref) => <span key={ref} className={`rail-pill ${ref === snapshot.mainBranch ? 'rail-main-ref' : 'rail-branch'}`} title={ref}>{ref}</span>)}
      <PullBadges pulls={linked} repository={snapshot.repository} />
      <span className="rail-subject">{merged ? `Merged: ${merged.title}` : commit.subject}</span>
    </div>
    <time className="rail-time" dateTime={commit.date}>{timeLabel(commit.date)}</time>
  </div>;
}

const ranges = [{ days: 3, label: 'Last 3 days' }, { days: 7, label: 'Last 7 days' }, { days: 0, label: 'Since the start' }];
type PullFilter = 'all' | RailPull['state'];

function PullTimeline({ snapshot }: { snapshot: RailMapSnapshot }) {
  const [days, setDays] = useState(7);
  const [filter, setFilter] = useState<PullFilter>('all');
  const taken = Date.parse(snapshot.takenAt);
  const startDay = new Date(days ? taken - days * 86_400_000 : Math.min(...snapshot.pulls.map((pull) => Date.parse(pull.createdAt)), taken));
  startDay.setHours(0, 0, 0, 0);
  const start = startDay.getTime(), end = taken + 3 * 3_600_000;
  const list = snapshot.pulls.filter((pull) => filter === 'all' || pull.state === filter)
    .map((pull) => ({ pull, span: pullSpan(pull, start, end, snapshot.takenAt) }))
    .filter((item): item is { pull: RailPull; span: { left: number; width: number } } => item.span !== null)
    .sort((a, b) => b.pull.number - a.pull.number);
  const ticks: number[] = [];
  for (const day = new Date(start); day.getTime() <= end; day.setDate(day.getDate() + 1)) ticks.push(day.getTime());
  const every = Math.max(1, Math.ceil(ticks.length / 8));
  const at = (time: number) => `${((time - start) / (end - start)) * 100}%`;
  return <>
    <div className="rail-toolbar">
      <label className="sr-only" htmlFor="rail-range">Time range</label>
      <select id="rail-range" value={days} onChange={(event) => setDays(Number(event.target.value))}>
        {ranges.map((range) => <option key={range.days} value={range.days}>{range.label}</option>)}
      </select>
      <label className="sr-only" htmlFor="rail-state">Which pull requests</label>
      <select id="rail-state" value={filter} onChange={(event) => setFilter(event.target.value as PullFilter)}>
        <option value="all">All pull requests</option><option value="open">Open</option><option value="merged">Merged</option><option value="closed">Closed without merging</option>
      </select>
      <ul className="rail-legend" aria-label="Legend">
        <li><i className="legend-open" />open, still running</li>
        <li><i style={{ background: 'var(--rail-merged)' }} />opened to merged</li>
        <li><i style={{ background: 'var(--rail-closed)' }} />closed</li>
      </ul>
    </div>
    <div className="rail-timeline">
      <div className="rail-axis">
        <span className="rail-axis-count">{list.length} pull requests</span>
        <div className="rail-ticks">{ticks.map((tick, index) => index % every === 0 && <span key={tick} style={{ left: at(tick) }}>{shortDay(tick)}</span>)}</div>
      </div>
      {list.length ? list.map(({ pull, span }) => <div key={pull.number} className="rail-timeline-row">
        <div className="rail-timeline-label">
          <a href={pullUrl(snapshot.repository, pull.number)} target="_blank" rel="noreferrer">#{pull.number}</a>
          <span title={pull.title}>{pull.title}</span>
        </div>
        <div className="rail-track" style={{ '--rail-day': `${(86_400_000 / (end - start)) * 100}%` } as CSSProperties}>
          <span className="rail-now" style={{ left: at(taken) }} />
          <span className={`rail-bar bar-${pull.state}`} style={{ left: `${span.left * 100}%`, width: `${span.width * 100}%` }}
            title={`#${pull.number} ${pull.title} · ${pull.state}${pull.agent ? ` · ${pull.agent}` : ''}`} />
        </div>
      </div>) : <p className="rail-empty">No pull requests in this range.</p>}
    </div>
  </>;
}

function BranchTable({ snapshot }: { snapshot: RailMapSnapshot }) {
  const pulls = useMemo(() => indexPulls(snapshot.pulls), [snapshot]);
  const most = Math.max(1, ...snapshot.branches.map((branch) => Math.max(branch.ahead, branch.behind)));
  const bar = (count: number) => count ? Math.max(2, Math.round(Math.sqrt(count / most) * 64)) : 0;
  return <div className="rail-branches">
    <table>
      <thead><tr><th scope="col">Branch and latest commit</th><th scope="col">State</th><th scope="col">Pull request</th><th scope="col" className="num">Ahead</th><th scope="col" className="num">Behind</th><th scope="col">Against main</th><th scope="col" className="num">Last commit</th></tr></thead>
      <tbody>{snapshot.branches.map((branch) => {
        const main = branch.name === snapshot.mainBranch;
        const pull = main ? undefined : pulls.byBranch.get(branch.name);
        return <tr key={branch.name}>
          <td className="rail-branch-name" data-label="Branch"><code>{branch.name}</code><span>{branch.subject}</span></td>
          <td data-label="State"><span className={`rail-state ${main ? 'trunk' : branch.ahead ? 'active' : 'done'}`}>{main ? 'trunk' : branch.ahead ? 'unmerged work' : 'fully merged'}</span></td>
          <td data-label="Pull request">{pull ? <PullBadges pulls={[pull]} repository={snapshot.repository} /> : <span className="rail-muted">none</span>}</td>
          <td className="num" data-label="Ahead">{branch.ahead}</td>
          <td className="num" data-label="Behind">{branch.behind}</td>
          <td data-label="Against main"><span className="rail-ab" title={`${branch.ahead} ahead, ${branch.behind} behind ${snapshot.mainBranch}`}>
            <span className="ahead" style={{ width: bar(branch.ahead) }} /><span className="behind" style={{ width: bar(branch.behind) }} /></span></td>
          <td className="num" data-label="Last commit">{shortDay(branch.date)}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
