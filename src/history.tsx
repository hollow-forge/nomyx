import { useState, useEffect, useRef, ReactElement } from "react";
import { useParams, useNavigate } from "react-router-dom";

interface HistoryRow {
  value: number | null;
  unit: string;
  status: string;
  recordedAt: string;
}

interface EventRow {
  fromStatus: string;
  toStatus: string;
  value: number | null;
  recordedAt: string;
  type: "event";
}

interface NoteRow {
  note: string;
  createdBy: string;
  createdAt: string;
  type: "note";
}

type EventOrNote = EventRow | NoteRow;

interface Thresholds { warn: number | null; crit: number | null; dir: string; }

const statusColor: Record<string, string> = {
  ok:         "#4ade80",
  warn:       "#f59e0b",
  crit:       "#f87171",
  unknown:    "#a855f7",
  suppressed: "#60a5fa",
};

const rangeLabels: Record<string, string> = {
  "1h":  "Last hour",
  "24h": "Last 24 hours",
  "7d":  "Last 7 days",
  "30d": "Last 30 days",
  "6mo": "Last 6 months",
  "1y":  "Last 12 months",
};

const STATUSES = ["ok", "warn", "crit", "unknown", "suppressed"];

// Worst-status-wins ranking, mirroring the server rollup: when several points
// collapse into one bucket, the bucket takes the most severe status so the line
// still turns red/amber wherever anything went wrong.
const STATUS_RANK: Record<string, number> = { crit: 5, warn: 4, unknown: 3, suppressed: 2, ok: 1 };
const RANK_STATUS: Record<number, string> = { 5: "crit", 4: "warn", 3: "unknown", 2: "suppressed", 1: "ok" };

// Target points per range. The aggregate ranges are deliberately coarser so they
// read as calm as the 24h view instead of a dense spiky band.
const TARGET_POINTS: Record<string, number> = {
  "1h": 24, "24h": 24, "7d": 28, "30d": 24, "6mo": 18, "1y": 14,
};

// Collapse a series down to at most `target` evenly-sized buckets: average the
// numeric value (ignoring gaps) and take the worst status across each bucket.
function downsample(rows: HistoryRow[], target: number): HistoryRow[] {
  if (rows.length <= target) return rows;
  const size = Math.ceil(rows.length / target);
  const out: HistoryRow[] = [];
  for (let i = 0; i < rows.length; i += size) {
    const grp  = rows.slice(i, i + size);
    const nums = grp.map(r => r.value).filter((v): v is number => v !== null);
    const avg  = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    let worst = 1;
    for (const r of grp) worst = Math.max(worst, STATUS_RANK[r.status] ?? 3);
    out.push({
      value:      avg === null ? null : Math.round(avg * 10) / 10,
      unit:       grp[0].unit,
      status:     RANK_STATUS[worst] ?? "unknown",
      recordedAt: grp[0].recordedAt,
    });
  }
  return out;
}

function StatusLineChart({ data, thresholds }: { data: HistoryRow[]; thresholds?: Thresholds | null }) {
  // Measure the container so we can render the SVG at real pixels —
  // keeps the line crisp and the status dots perfectly round at any width.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  if (data.length === 0) {
    return (
      <div className="line-chart" ref={wrapRef}>
        <div className="line-empty-track" />
        <div className="line-labels"><span>—</span><span>now</span></div>
      </div>
    );
  }

  // Checks that report a status but no numeric value (e.g. a pure up/down
  // service check) have nothing to plot — fall back to a thin status strip
  // so they are never blank.
  const numeric = data.filter(d => d.value !== null) as (HistoryRow & { value: number })[];
  if (numeric.length === 0) {
    return (
      <div className="line-chart" ref={wrapRef}>
        <div className="line-status-strip">
          {data.map((row, i) => (
            <div key={i} className="line-status-cell"
              style={{ background: statusColor[row.status] ?? statusColor.unknown }}
              title={`${new Date(row.recordedAt).toLocaleString()}\n${row.status}`} />
          ))}
        </div>
        <div className="line-labels">
          <span>{new Date(data[0].recordedAt).toLocaleString()}</span><span>now</span>
        </div>
      </div>
    );
  }

  const H = 96, padL = 42, padR = 10, padT = 12, padB = 8;
  const innerW = Math.max(1, w - padL - padR);
  const innerH = H - padT - padB;

  const vals = numeric.map(d => d.value);
  const tvals: number[] = [];
  if (thresholds) {
    if (thresholds.warn != null) tvals.push(thresholds.warn);
    if (thresholds.crit != null) tvals.push(thresholds.crit);
  }
  let min = Math.min(...vals, ...tvals), max = Math.max(...vals, ...tvals);
  if (min === max) { min -= 1; max += 1; }   // avoid a divide-by-zero on a flat series
  const unit = numeric[0].unit ?? "";

  const n = data.length;
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * innerH;

  // Shaded warn/crit zones behind the line. Drawn first so the line sits on top.
  const bandRect = (vLow: number, vHigh: number, color: string, op: number, key: string) => {
    const yA = y(vHigh), yB = y(vLow);
    return <rect key={key} x={padL} y={Math.min(yA, yB)} width={w - padL - padR} height={Math.abs(yB - yA)} fill={color} opacity={op} />;
  };

  // Colour each segment by the status of the point it arrives at, so the line
  // visibly turns amber/red exactly where the check did. Null points break the
  // line into gaps rather than drawing a misleading straight jump.
  const segs: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
  let prev: { i: number; v: number } | null = null;
  data.forEach((row, i) => {
    if (row.value === null) { prev = null; return; }
    if (prev) {
      segs.push({
        x1: x(prev.i), y1: y(prev.v), x2: x(i), y2: y(row.value),
        color: statusColor[row.status] ?? statusColor.unknown,
      });
    }
    prev = { i, v: row.value };
  });

  const fmt = (v: number) => (Number.isInteger(v) ? `${v}` : v.toFixed(1));

  return (
    <div className="line-chart" ref={wrapRef}>
      <svg width={w} height={H} className="line-chart-svg">
        {thresholds && (() => {
          const { warn, crit, dir } = thresholds;
          const els: ReactElement[] = [];
          if (dir === "below") {
            if (crit != null) els.push(bandRect(min, crit, "#f87171", 0.13, "cb"));
            if (warn != null) els.push(bandRect(crit != null ? crit : min, warn, "#f59e0b", 0.10, "wb"));
          } else {
            if (crit != null) els.push(bandRect(crit, max, "#f87171", 0.13, "cb"));
            if (warn != null) els.push(bandRect(warn, crit != null ? crit : max, "#f59e0b", 0.10, "wb"));
          }
          if (warn != null) els.push(<line key="wl" x1={padL} y1={y(warn)} x2={w - padR} y2={y(warn)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3" opacity={0.55} />);
          if (crit != null) els.push(<line key="cl" x1={padL} y1={y(crit)} x2={w - padR} y2={y(crit)} stroke="#f87171" strokeWidth={1} strokeDasharray="3 3" opacity={0.55} />);
          return <g>{els}</g>;
        })()}
        {/* min / max gridlines + labels */}
        <line x1={padL} y1={y(max)} x2={w - padR} y2={y(max)} className="line-grid" />
        <line x1={padL} y1={y(min)} x2={w - padR} y2={y(min)} className="line-grid" />
        <text x={padL - 6} y={y(max) + 3} className="line-axis-text" textAnchor="end">{fmt(max)}{unit}</text>
        <text x={padL - 6} y={y(min) + 3} className="line-axis-text" textAnchor="end">{fmt(min)}{unit}</text>
        {/* status-coloured line segments */}
        {segs.map((sg, i) => (
          <line key={i} x1={sg.x1} y1={sg.y1} x2={sg.x2} y2={sg.y2}
            stroke={sg.color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {/* status-coloured points */}
        {data.map((row, i) => row.value === null ? null : (
          <circle key={i} cx={x(i)} cy={y(row.value)} r={2.2}
            fill={statusColor[row.status] ?? statusColor.unknown}>
            <title>{`${new Date(row.recordedAt).toLocaleString()}\n${row.value}${row.unit} \u00b7 ${row.status}`}</title>
          </circle>
        ))}
      </svg>
      <div className="line-labels">
        <span>{new Date(data[0].recordedAt).toLocaleString()}</span>
        <span>now</span>
      </div>
    </div>
  );
}

export default function History() {
  const { hostname, checkName } = useParams<{ hostname: string; checkName: string }>();
  const navigate = useNavigate();
  const [data, setData]           = useState<Record<string, HistoryRow[]>>({});
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [allEvents, setAllEvents] = useState<EventOrNote[]>([]);
  const [loading, setLoading]     = useState(true);

  // Filters
  const [search,     setSearch]     = useState("");
  const [dateFrom,   setDateFrom]   = useState("");
  const [dateTo,     setDateTo]     = useState("");
  const [fromStatus, setFromStatus] = useState("");
  const [toStatus,   setToStatus]   = useState("");
  const [showType,   setShowType]   = useState<"all"|"events"|"notes">("all");

  const load = async () => {
    const res  = await fetch(`/api/history/${hostname}/${checkName}/all`);
    const json = await res.json();
    setData(json.ranges);
    setThresholds(json.thresholds ?? null);
    setAllEvents([
      ...json.events.map((e: any) => ({ ...e, type: "event" as const })),
      ...json.notes.map((n: any)  => ({ ...n, type: "note"  as const })),
    ].sort((a, b) => {
      const aTime = a.type === "event" ? a.recordedAt : a.createdAt;
      const bTime = b.type === "event" ? b.recordedAt : b.createdAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    }));
    setLoading(false);
  };

  useEffect(() => { void load(); }, [hostname, checkName]);

  const hasFilters = search || dateFrom || dateTo || fromStatus || toStatus || showType !== "all";

  const clearFilters = () => {
    setSearch(""); setDateFrom(""); setDateTo("");
    setFromStatus(""); setToStatus(""); setShowType("all");
  };

  const filtered = allEvents.filter(e => {
    // Type filter
    if (showType === "events" && e.type !== "event") return false;
    if (showType === "notes"  && e.type !== "note")  return false;

    // Date filter
    const time = e.type === "event" ? e.recordedAt : e.createdAt;
    if (dateFrom && new Date(time) < new Date(dateFrom)) return false;
    if (dateTo   && new Date(time) > new Date(dateTo + "T23:59:59")) return false;

    // Status transition filter (events only)
    if (fromStatus || toStatus) {
      if (e.type !== "event") return false;
      if (fromStatus && e.fromStatus !== fromStatus) return false;
      if (toStatus   && e.toStatus   !== toStatus)   return false;
    }

    // Text search (notes and events)
    if (search) {
      const q = search.toLowerCase();
      if (e.type === "note") {
        if (!e.note.toLowerCase().includes(q) && !e.createdBy.toLowerCase().includes(q)) return false;
      } else {
        const text = `${e.fromStatus} ${e.toStatus} ${e.value ?? ""}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
    }

    return true;
  });

  if (loading) return (
    <div className="app" style={{ color: "#8b8fa8" }}>Loading…</div>
  );

  return (
    <div className="app">
      <button className="back-btn" onClick={() => navigate(-1)}>← Back</button>

      <div className="history-header">
        <h1 className="detail-title">{hostname}</h1>
        <h2 className="history-check-name">{checkName}</h2>
      </div>

      <div className="history-layout">

        {/* Left — bar timelines */}
        <div className="history-left">
          {Object.entries(rangeLabels).map(([range, label]) => (
            <div key={range} className="history-range-block">
              <div className="history-range-label">{label}</div>
              <StatusLineChart data={downsample(data[range] ?? [], TARGET_POINTS[range] ?? 24)} thresholds={thresholds} />
            </div>
          ))}
        </div>

        {/* Right — event log */}
        <div className="history-right">
          <div className="history-event-log">
            <div className="history-event-title">Status history &amp; notes</div>

            {/* ── Search & filter bar ── */}
            <div className="event-filter-bar">
              <input
                className="event-filter-search"
                type="text"
                placeholder="Search notes and events…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <div className="event-filter-row">
                <div className="event-filter-group">
                  <label className="event-filter-label">Type</label>
                  <select className="event-filter-select" value={showType} onChange={e => setShowType(e.target.value as any)}>
                    <option value="all">All</option>
                    <option value="events">Events only</option>
                    <option value="notes">Notes only</option>
                  </select>
                </div>
                <div className="event-filter-group">
                  <label className="event-filter-label">From status</label>
                  <select className="event-filter-select" value={fromStatus} onChange={e => setFromStatus(e.target.value)}>
                    <option value="">Any</option>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="event-filter-group">
                  <label className="event-filter-label">To status</label>
                  <select className="event-filter-select" value={toStatus} onChange={e => setToStatus(e.target.value)}>
                    <option value="">Any</option>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div className="event-filter-row">
                <div className="event-filter-group">
                  <label className="event-filter-label">From date</label>
                  <input className="event-filter-date" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                </div>
                <div className="event-filter-group">
                  <label className="event-filter-label">To date</label>
                  <input className="event-filter-date" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
                </div>
                {hasFilters && (
                  <button className="event-filter-clear" onClick={clearFilters}>Clear filters</button>
                )}
              </div>
            </div>

            <div className="event-list">
              {hasFilters && (
                <div className="event-filter-count">
                  {filtered.length} result{filtered.length !== 1 ? "s" : ""}
                  {filtered.length !== allEvents.length && ` of ${allEvents.length}`}
                </div>
              )}
              {filtered.length === 0 && (
                <div className="no-data">
                  {hasFilters ? "No results match your filters" : "No status changes or notes yet"}
                </div>
              )}
              {filtered.map((e, i) => {
                if (e.type === "event") {
                  return (
                    <div key={i} className="event-row">
                      <span className="event-time">
                        {new Date(e.recordedAt).toLocaleString()}
                      </span>
                      <span className="event-dot"
                        style={{ background: statusColor[e.toStatus] ?? statusColor.unknown }} />
                      <span className="event-text">
                        <strong style={{ color: statusColor[e.fromStatus] }}>{e.fromStatus}</strong>
                        {" → "}
                        <strong style={{ color: statusColor[e.toStatus] }}>{e.toStatus}</strong>
                        {e.value !== null && ` (${e.value})`}
                      </span>
                    </div>
                  );
                } else {
                  return (
                    <div key={i} className="event-row note-row">
                      <span className="event-time">
                        {new Date(e.createdAt).toLocaleString()}
                      </span>
                      <span className="note-icon">✎</span>
                      <span className="event-text">
                        <strong>{e.createdBy}:</strong> {e.note}
                      </span>
                    </div>
                  );
                }
              })}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}