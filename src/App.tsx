import { useState, useEffect, useCallback } from "react";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import ReactMarkdown  from "react-markdown";
import remarkGfm      from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import History from "./history";
import Login   from "./Login";
import Account from "./account";
import AuthCallback from "./authCallBack";
import Users    from "./Users";
import Settings  from "./settings";
import Templates from "./templates";

interface CheckValue {
  name:   string;
  value:  number | string;
  unit:   string;
  status: string;
  group?: string;
}

interface HostRecord {
  hostname:        string;
  group:           string;
  ip?:             string;
  division?:       string | null;
  department?:     string | null;
  status:          string;
  lastSeen:        string;
  checks:          CheckValue[];
  lastError?:      string | null;
  alertingEnabled?: boolean;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s    = Math.floor(diff / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

const STATUS_ORDER: Record<string, number> = { crit: 0, warn: 1, unknown: 2, suppressed: 3, ok: 4 };

function sortWorstFirst(hosts: HostRecord[]): HostRecord[] {
  return [...hosts].sort((a, b) => (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5));
}

function StatusBadge({ status }: { status: string }) {
  const s = status ?? "unknown";
  return (
    <span className={`badge badge-${s}`}>
      <span className="badge-dot" />
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
}

function CheckPills({ checks, onlyNonGreen }: { checks: CheckValue[]; onlyNonGreen: boolean }) {
  const visible = onlyNonGreen
    ? checks.filter(c => c.status !== "ok" && c.status !== "suppressed")
    : checks;
  if (visible.length === 0 && onlyNonGreen) return <span style={{ fontSize: 12, color: "#555870" }}>—</span>;
  return (
    <div className="checks-cell">
      {visible.map(c => (
        <span key={c.name} className={`check-pill pill-${c.status ?? "unknown"}`}>{c.name}</span>
      ))}
    </div>
  );
}

// ── Role helpers ───────────────────────────────────────────────────────────────

function isAdmin(user: any)    { return ["global_admin", "admin"].includes(user?.role); }
function canOperate(user: any) { return ["global_admin", "admin", "noc", "operator"].includes(user?.role); }

// ── Inline confirm button ──────────────────────────────────────────────────────

function RemoveButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="remove-host-cell">
        <div className="confirm-inline">
          <span style={{ fontSize: 12, color: "#f87171", whiteSpace: "nowrap" }}>Remove host?</span>
          <button className="confirm-danger-btn" onClick={e => { e.stopPropagation(); onConfirm(); }}>Yes, remove</button>
          <button className="confirm-cancel-btn" onClick={e => { e.stopPropagation(); setConfirming(false); }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="remove-host-cell">
      <button className="remove-host-btn" onClick={e => { e.stopPropagation(); setConfirming(true); }}>
        {label}
      </button>
    </div>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────────

function Header({ user, setUser }: { user: any; setUser: (u: any) => void }) {
  const navigate      = useNavigate();
  const location      = useLocation();
  const [showAccount, setShowAccount] = useState(false);

  const showNoc       = isAdmin(user) || user?.role === "noc";
  const showUsers     = isAdmin(user);
  const showSettings  = isAdmin(user);
  const showAudit     = isAdmin(user);
  const showAgent     = isAdmin(user);
  const showTemplates = true; // everyone can browse templates
  const path      = location.pathname;

  const navBtn = (label: string, to: string) => (
    <button
      className={`nav-btn ${path === to ? "active" : ""}`}
      onClick={() => navigate(to)}
    >{label}</button>
  );

  return (
    <div className="header">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="header-dot" />
        <span className="header-title">Nomyx</span>
      </div>
      <div className="nav">
        {navBtn("Dashboard", "/")}
        {showNoc   && navBtn("NOC view", "/noc")}
        {showUsers    && navBtn("Users",    "/users")}
        {showSettings  && navBtn("Settings",  "/settings")}
        {showTemplates && navBtn("Templates", "/templates")}
        {showAudit     && navBtn("Audit",     "/audit")}
        {showAgent     && navBtn("Get Agent", "/get-agent")}
      </div>
      <div className="header-spacer">
        <button className="header-user-btn" onClick={() => setShowAccount(true)}>
          {user?.displayName}
        </button>
        <button className="header-signout-btn" onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          setUser(null);
        }}>
          Sign out
        </button>
      </div>
      {showAccount && <Account user={user} onClose={() => setShowAccount(false)} />}
    </div>
  );
}

// ── Runbook panel ──────────────────────────────────────────────────────────────

function RunbookPanel({ hostname, canEdit }: { hostname: string; canEdit: boolean }) {
  const [content,   setContent]   = useState("");
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loaded,    setLoaded]    = useState(false);
  const [editing,   setEditing]   = useState(false);
  const [draft,     setDraft]     = useState("");
  const [preview,   setPreview]   = useState(false);
  const [saving,    setSaving]    = useState(false);

  const load = useCallback(() => {
    fetch(`/api/hosts/${encodeURIComponent(hostname)}/runbook`)
      .then(r => r.json())
      .then(d => {
        setContent(d.content ?? "");
        setUpdatedBy(d.updatedBy ?? null);
        setUpdatedAt(d.updatedAt ?? null);
        setLoaded(true);
      });
  }, [hostname]);

  useEffect(() => { load(); }, [load]);

  const startEdit  = () => { setDraft(content); setPreview(false); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setPreview(false); };

  const save = async () => {
    setSaving(true);
    const res = await fetch(`/api/hosts/${encodeURIComponent(hostname)}/runbook`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: draft }),
    });
    if (res.ok) {
      const d = await res.json();
      setContent(draft);
      setUpdatedBy(d.updatedBy ?? null);
      setUpdatedAt(d.updatedAt ?? null);
      setEditing(false);
      setPreview(false);
    }
    setSaving(false);
  };

  if (!loaded) return null;

  return (
    <div className="runbook-panel">
      <div className="runbook-header">
        <div className="runbook-title">📖 Runbook</div>
        {editing ? (
          <div className="runbook-actions">
            <div className="runbook-tabs">
              <button className={`runbook-tab ${!preview ? "runbook-tab-active" : ""}`} onClick={() => setPreview(false)}>Write</button>
              <button className={`runbook-tab ${preview  ? "runbook-tab-active" : ""}`} onClick={() => setPreview(true)}>Preview</button>
            </div>
            <button className="runbook-save-btn" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            <button className="confirm-cancel-btn" onClick={cancelEdit} disabled={saving}>Cancel</button>
          </div>
        ) : (
          canEdit && content && (
            <button className="runbook-edit-btn" onClick={startEdit}>✎ Edit</button>
          )
        )}
      </div>

      {editing ? (
        preview ? (
          <div className="runbook-body md-body">
            {draft.trim()
              ? <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{draft}</ReactMarkdown>
              : <div className="runbook-empty-text">Nothing to preview yet.</div>}
          </div>
        ) : (
          <textarea className="runbook-textarea" value={draft} onChange={e => setDraft(e.target.value)}
            placeholder="Write the runbook in Markdown — # headings, **bold**, `code`, lists, and tables are all supported." />
        )
      ) : content ? (
        <>
          <div className="runbook-body md-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{content}</ReactMarkdown>
          </div>
          {updatedAt && (
            <div className="runbook-footer">↻ Last edited{updatedBy ? ` by ${updatedBy}` : ""} · {new Date(updatedAt).toLocaleString()}</div>
          )}
        </>
      ) : (
        <div className="runbook-empty">
          <span className="runbook-empty-text">No runbook yet.</span>
          {canEdit && <button className="runbook-add-btn" onClick={startEdit}>+ Add runbook</button>}
        </div>
      )}
    </div>
  );
}

// ── Host detail ────────────────────────────────────────────────────────────────

function HostDetail({ host, user, onBack, onRemoved }: { host: HostRecord; user: any; onBack: () => void; onRemoved: () => void }) {
  const navigate = useNavigate();
  const [suppressions,  setSuppressions]  = useState<any[]>([]);
  const [selected,      setSelected]      = useState<string[]>([]);
  const [reason,        setReason]        = useState("");
  const [reasonError,   setReasonError]   = useState(false);
  const [until,         setUntil]         = useState<"ok"|"4h"|"8h"|"12h"|"datetime">("ok");
  const [untilDate,     setUntilDate]     = useState("");
  const [startWhen,     setStartWhen]     = useState<"now"|"datetime">("now");
  const [startDate,     setStartDate]     = useState("");
  const [confirmRemove,    setConfirmRemove]    = useState(false);
  const [alertingEnabled,   setAlertingEnabled]   = useState(host.alertingEnabled !== false);
  const [templates,         setTemplates]         = useState<any[]>([]);
  const [showGenerate,      setShowGenerate]      = useState(false);
  const [selectedTemplate,  setSelectedTemplate]  = useState("");
  const [links,         setLinks]         = useState<any[]>([]);
  const [newLinkLabel,  setNewLinkLabel]  = useState("");
  const [newLinkUrl,    setNewLinkUrl]    = useState("");
  const [showAddLink,   setShowAddLink]   = useState(false);

  const userIsAdmin   = isAdmin(user);
  const userCanOperate = canOperate(user);

  const loadSuppressions = useCallback(() => {
    fetch(`/api/suppressions/${encodeURIComponent(host.hostname)}`).then(r => r.json()).then(setSuppressions);
  }, [host.hostname]);

  const loadLinks = useCallback(() => {
    fetch(`/api/hosts/${encodeURIComponent(host.hostname)}/links`).then(r => r.json()).then(setLinks);
  }, [host.hostname]);

  useEffect(() => {
    loadSuppressions(); loadLinks();
    fetch("/api/templates").then(r => r.json()).then(setTemplates);
  }, [loadSuppressions, loadLinks]);

  const addLink = async () => {
    if (!newLinkLabel.trim() || !newLinkUrl.trim()) return;
    await fetch(`/api/hosts/${encodeURIComponent(host.hostname)}/links`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: newLinkLabel, url: newLinkUrl }),
    });
    setNewLinkLabel(""); setNewLinkUrl(""); setShowAddLink(false); loadLinks();
  };

  const removeLink = async (id: number) => {
    await fetch(`/api/hosts/${encodeURIComponent(host.hostname)}/links/${id}`, { method: "DELETE" });
    loadLinks();
  };

  const isCheckSuppressed = (name: string) => suppressions.some(s => s.checkName === name || s.checkName === "all");
  const toggleCheck    = (name: string) => setSelected(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  const selectAll      = () => setSelected(host.checks.map(c => c.name));
  const selectNonGreen = () => setSelected(host.checks.filter(c => c.status !== "ok" && c.status !== "suppressed").map(c => c.name));
  const clearSelected  = () => setSelected([]);

  const computeExpiresAt = (): string | null => {
    if (until === "ok")       return null;
    if (until === "datetime") return untilDate || null;
    const hours = until === "4h" ? 4 : until === "8h" ? 8 : 12;
    const base  = startWhen === "now" ? new Date() : new Date(startDate || Date.now());
    return new Date(base.getTime() + hours * 60 * 60 * 1000).toISOString();
  };

  const applySuppress = async () => {
    if (!reason.trim()) { setReasonError(true); return; }
    if (selected.length === 0) return;
    setReasonError(false);
    await fetch("/api/suppressions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: host.hostname, checks: selected, reason: reason.trim(),
        suppressedBy: "user", startsAt: startWhen === "now" ? null : startDate || null,
        expiresAt: computeExpiresAt(), autoLiftOnOk: until === "ok"
      })
    });
    setSelected([]); setReason(""); loadSuppressions();
  };

  const liftSuppression = async (id: number) => {
    await fetch(`/api/suppressions/${id}`, { method: "DELETE" }); loadSuppressions();
  };

  const removeHost = async () => {
    await fetch(`/api/hosts/${encodeURIComponent(host.hostname)}`, { method: "DELETE" });
    onRemoved();
  };

  const toggleAlerting = async (enabled: boolean) => {
    setAlertingEnabled(enabled);
    await fetch(`/api/hosts/${encodeURIComponent(host.hostname)}/alerting`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  };

  const downloadConfig = () => {
    const tpl = templates.find(t => String(t.id) === selectedTemplate);
    if (!tpl) return;
    const cfg = {
      host:            host.hostname,
      group:           host.group,
      division:        host.division   ?? undefined,
      department:      host.department ?? undefined,
      token:           "YOUR_TOKEN",
      serverUrl:       "http://YOUR_SERVER:4433",
      intervalSeconds: 60,
      checks:          tpl.checks,
    };
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `nomyx-${host.hostname}.json`; a.click();
    URL.revokeObjectURL(url);
    setShowGenerate(false); setSelectedTemplate("");
  };

  const grouped = host.checks.reduce((acc: Record<string, CheckValue[]>, check) => {
    const g = check.group ?? "General";
    if (!acc[g]) acc[g] = [];
    acc[g].push(check);
    return acc;
  }, {});

  return (
    <div className="app">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <button className="back-btn" onClick={onBack} style={{ marginBottom: 0 }}>← Back to dashboard</button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {userIsAdmin && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: alertingEnabled ? "#4ade80" : "#555870", cursor: "pointer" }}>
              <input type="checkbox" checked={alertingEnabled} onChange={e => void toggleAlerting(e.target.checked)}
                style={{ accentColor: "#4ade80" }} />
              Alerts {alertingEnabled ? "on" : "off"}
            </label>
          )}
          {userIsAdmin && templates.length > 0 && (
            showGenerate ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <select className="um-inline-select" value={selectedTemplate} onChange={e => setSelectedTemplate(e.target.value)}>
                  <option value="">— Pick template —</option>
                  {templates.map(t => <option key={t.id} value={String(t.id)}>{t.name}</option>)}
                </select>
                <button className="settings-run-btn" onClick={downloadConfig} disabled={!selectedTemplate}>↓ Download</button>
                <button className="confirm-cancel-btn" onClick={() => { setShowGenerate(false); setSelectedTemplate(""); }}>Cancel</button>
              </div>
            ) : (
              <button className="settings-run-btn" onClick={() => setShowGenerate(true)}>Generate config</button>
            )
          )}
          {userIsAdmin && (
            confirmRemove ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "#f87171" }}>Remove this host and all its data?</span>
                <button className="confirm-danger-btn" onClick={removeHost}>Yes, remove</button>
                <button className="confirm-cancel-btn" onClick={() => setConfirmRemove(false)}>Cancel</button>
              </div>
            ) : (
              <button className="remove-host-btn" onClick={() => setConfirmRemove(true)}>Remove host</button>
            )
          )}
        </div>
      </div>

      <div className="detail-header">
        <div>
          <div className="detail-title">{host.hostname}</div>
          <div className="detail-sub">{host.ip && `${host.ip} · `}{host.group} · Last seen {relativeTime(host.lastSeen)}</div>
          {host.lastError && (
            <div style={{ fontSize: 12, color: "#f87171", marginTop: 4 }}>⚠ {host.lastError}</div>
          )}
        </div>
        <StatusBadge status={host.status} />
      </div>

      {/* ── Host links ── */}
      {(links.length > 0 || userIsAdmin) && (
        <div className="host-links">
          {links.map(link => (
            <div key={link.id} className="host-link-item">
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="host-link-anchor">
                <span className="host-link-icon">🔗</span>
                <span className="host-link-label">{link.label}</span>
                <span className="host-link-url">{link.url}</span>
              </a>
              {userIsAdmin && (
                <button className="host-link-remove" onClick={() => removeLink(link.id)}>✕</button>
              )}
            </div>
          ))}
          {userIsAdmin && (
            showAddLink ? (
              <div className="host-link-add-form">
                <input className="host-link-input" placeholder="Label (e.g. Runbook)" value={newLinkLabel} onChange={e => setNewLinkLabel(e.target.value)} />
                <input className="host-link-input" placeholder="https://wiki.example.com/..." value={newLinkUrl} onChange={e => setNewLinkUrl(e.target.value)} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="host-link-save" onClick={() => void addLink()}>Add link</button>
                  <button className="confirm-cancel-btn" onClick={() => { setShowAddLink(false); setNewLinkLabel(""); setNewLinkUrl(""); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="host-link-add-btn" onClick={() => setShowAddLink(true)}>+ Add link</button>
            )
          )}
        </div>
      )}

      {Object.entries(grouped).map(([groupName, checks]) => (
        <div key={groupName} className="check-group">
          <div className="check-group-label">{groupName}</div>
          <table className="check-table">
            <tbody>
              {checks.map(check => {
                const suppressed = isCheckSuppressed(check.name);
                const status     = suppressed ? "suppressed" : (check.status ?? "unknown");
                return (
                  <tr key={check.name} className="check-table-row"
                    onClick={() => navigate(`/history/${encodeURIComponent(host.hostname)}/${encodeURIComponent(check.name)}`)}>
                    <td className="check-table-name">{check.name}</td>
                    <td className="check-table-value">
                      <span className={`color-${status === "ok" ? "ok" : status === "warn" ? "warn" : status === "crit" ? "crit" : status === "invalid" ? "invalid" : status === "suppressed" ? "suppressed" : "default"}`}>
                        {String(check.value)}
                        {check.unit !== "string" && <span className="check-unit"> {check.unit}</span>}
                      </span>
                    </td>
                    <td><StatusBadge status={status} /></td>
                    <td className="check-table-history">View history →</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {/* Active suppressions — visible to all, lift button only for operators */}
      {suppressions.length > 0 && (
        <div className="suppress-active">
          <div className="suppress-active-title">Active suppressions</div>
          {suppressions.map((s: any) => (
            <div key={s.id} className="suppress-active-row">
              <span className="suppress-active-check">{s.checkName}</span>
              <span className="suppress-active-reason">{s.reason}</span>
              <span className="suppress-active-exp">{s.expiresAt ? `until ${new Date(s.expiresAt).toLocaleString()}` : "until OK"}</span>
              {userCanOperate && (
                <button className="suppress-lift-btn" onClick={() => liftSuppression(s.id)}>Lift</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Suppress box — operators only */}
      {userCanOperate && (
        <div className="suppress-box">
          <div className="suppress-box-title">Suppress metrics</div>
          <div className="suppress-bubbles">
            {host.checks.map(check => {
              const isSelected = selected.includes(check.name);
              const suppressed = isCheckSuppressed(check.name);
              const status     = suppressed ? "suppressed" : check.status;
              return (
                <button key={check.name} onClick={() => toggleCheck(check.name)}
                  className={`suppress-bubble suppress-bubble-${status} ${isSelected ? "suppress-bubble-selected" : ""}`}>
                  <span className="suppress-bubble-dot" />{check.name}
                </button>
              );
            })}
          </div>
          <div className="suppress-selection-btns">
            <button className="suppress-sel-btn" onClick={selectAll}>Select all</button>
            <button className="suppress-sel-btn" onClick={selectNonGreen}>All non-green</button>
            <button className="suppress-sel-btn" onClick={clearSelected}>Clear</button>
          </div>
          <div className="suppress-section-label">Suppress until:</div>
          <div className="suppress-options">
            {(["ok","4h","8h","12h","datetime"] as const).map(opt => (
              <label key={opt} className="suppress-radio">
                <input type="radio" name="until" value={opt} checked={until === opt} onChange={() => setUntil(opt)} />
                {opt === "ok" ? "Returns to OK" : opt === "datetime" ? "Specific date/time" : opt}
              </label>
            ))}
          </div>
          {until === "datetime" && <input type="datetime-local" value={untilDate} onChange={e => setUntilDate(e.target.value)} className="suppress-datetime" />}
          <div className="suppress-section-label">Start:</div>
          <div className="suppress-options">
            <label className="suppress-radio"><input type="radio" name="start" value="now" checked={startWhen === "now"} onChange={() => setStartWhen("now")} />Now</label>
            <label className="suppress-radio"><input type="radio" name="start" value="datetime" checked={startWhen === "datetime"} onChange={() => setStartWhen("datetime")} />Specific date/time</label>
          </div>
          {startWhen === "datetime" && <input type="datetime-local" value={startDate} onChange={e => setStartDate(e.target.value)} className="suppress-datetime" />}
          <div className="suppress-section-label">Note (required):</div>
          <input value={reason} onChange={e => { setReason(e.target.value); setReasonError(false); }}
            placeholder="Reason for suppression…" className={`suppress-note ${reasonError ? "suppress-note-error" : ""}`} />
          {reasonError && <div className="suppress-error">A note is required before suppressing.</div>}
          <button className="suppress-apply-btn" onClick={() => void applySuppress()} disabled={selected.length === 0}>
            Apply suppression {selected.length > 0 ? `(${selected.length} checks)` : ""}
          </button>
        </div>
      )}

      <RunbookPanel hostname={host.hostname} canEdit={userCanOperate} />
    </div>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────────

function Dashboard({ user, setUser }: { user: any; setUser: (u: any) => void }) {
  const [hosts,      setHosts]      = useState<HostRecord[]>([]);
  const [selected,   setSelected]   = useState<HostRecord | null>(null);
  const [cardFilter, setCardFilter] = useState<string | null>(null);

  const userIsAdmin = isAdmin(user);

  const load = () => fetch("/api/hosts").then(r => r.json()).then(setHosts);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  const removeHost = async (hostname: string) => {
    await fetch(`/api/hosts/${encodeURIComponent(hostname)}`, { method: "DELETE" });
    load();
  };

  const counts = {
    nonGreen:   hosts.filter(h => h.status !== "ok" && h.status !== "suppressed").length,
    ok:         hosts.filter(h => h.status === "ok").length,
    warn:       hosts.filter(h => h.status === "warn").length,
    invalid:    hosts.filter(h => h.status === "invalid").length,
    crit:       hosts.filter(h => h.status === "crit").length,
    unknown:    hosts.filter(h => h.status === "unknown").length,
    suppressed: hosts.filter(h => h.status === "suppressed").length,
  };

  const filtered = hosts.filter(h => {
    if (cardFilter === "nongreen")   return h.status !== "ok" && h.status !== "suppressed";
    if (cardFilter === "ok")         return h.status === "ok";
    if (cardFilter === "warn")       return h.status === "warn";
    if (cardFilter === "invalid")    return h.status === "invalid";
    if (cardFilter === "crit")       return h.status === "crit";
    if (cardFilter === "unknown")    return h.status === "unknown";
    if (cardFilter === "suppressed") return h.status === "suppressed";
    return true;
  });

  if (selected) return (
    <>
      <HostDetail host={selected} user={user} onBack={() => setSelected(null)} onRemoved={() => { setSelected(null); load(); }} />
    </>
  );

  return (
    <div className="app">
      <div className="stat-row">
        {[
          { label: "Non-green",  value: counts.nonGreen,   color: "color-crit",       filter: "nongreen"   },
          { label: "Healthy",    value: counts.ok,          color: "color-ok",         filter: "ok"         },
          { label: "Warning",    value: counts.warn,        color: "color-warn",       filter: "warn"       },
          { label: "Invalid",    value: counts.invalid,     color: "color-invalid",    filter: "invalid"    },
          { label: "Critical",   value: counts.crit,        color: "color-crit",       filter: "crit"       },
          { label: "Unknown",    value: counts.unknown,     color: "color-unknown",    filter: "unknown"    },
          { label: "Suppressed", value: counts.suppressed,  color: "color-suppressed", filter: "suppressed" },
        ].map(s => (
          <div key={s.label} className={`stat-card ${cardFilter === s.filter ? "stat-card-active" : ""}`}
            onClick={() => setCardFilter(cardFilter === s.filter ? null : s.filter)} style={{ cursor: "pointer" }}>
            <div className="stat-label">{s.label}</div>
            <div className={`stat-value ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <div className="table-title">
          Hosts
          {cardFilter && (
            <span style={{ fontSize: 12, color: "#8b8fa8", marginLeft: 8 }}>
              filtering: {cardFilter}
              <button onClick={() => setCardFilter(null)} style={{ marginLeft: 6, background: "none", border: "none", color: "#60a5fa", cursor: "pointer", fontSize: 12 }}>clear</button>
            </span>
          )}
        </div>
        <table>
          <thead>
            <tr>
              <th>Hostname</th>
              <th>Status</th>
              <th>Group</th>
              <th>Checks</th>
              <th>Last seen</th>
              {userIsAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map(host => (
              <tr key={host.hostname} className="host-row" onClick={() => setSelected(host)}>
                <td><div className="host-name">{host.hostname}</div>{host.ip && <div className="host-ip">{host.ip}</div>}</td>
                <td><StatusBadge status={host.status} /></td>
                <td className="color-muted">{host.group}</td>
                <td><CheckPills checks={host.checks} onlyNonGreen={cardFilter === "nongreen"} /></td>
                <td className="color-faint">
                  {relativeTime(host.lastSeen)}
                  {host.lastError && (
                    <div style={{ fontSize: 12, color: "#f87171", marginTop: 2 }}>⚠ {host.lastError}</div>
                  )}
                </td>
                {userIsAdmin && (
                  <td style={{ width: 160 }}>
                    <RemoveButton label="Remove host" onConfirm={() => removeHost(host.hostname)} />
                  </td>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={userIsAdmin ? 6 : 5} style={{ padding: "20px 16px", textAlign: "center", color: "#555870", fontSize: 13 }}>No hosts match this filter</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── NOC View ───────────────────────────────────────────────────────────────────

function NocView({ user, setUser }: { user: any; setUser: (u: any) => void }) {
  const [hosts,      setHosts]      = useState<HostRecord[]>([]);
  const [selected,   setSelected]   = useState<HostRecord | null>(null);
  const [cardFilter, setCardFilter] = useState<string | null>(null);
  const [countdown,  setCountdown]  = useState(30);

  const userIsAdmin = isAdmin(user);

  const load = () => {
    fetch("/api/hosts").then(r => r.json()).then(setHosts);
    setCountdown(30);
  };

  useEffect(() => {
    load();
    const dataInterval = setInterval(load, 30000);
    const tickInterval = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => { clearInterval(dataInterval); clearInterval(tickInterval); };
  }, []);

  const removeHost = async (hostname: string) => {
    await fetch(`/api/hosts/${encodeURIComponent(hostname)}`, { method: "DELETE" });
    load();
  };

  const counts = {
    nonGreen:   hosts.filter(h => h.status !== "ok" && h.status !== "suppressed").length,
    crit:       hosts.filter(h => h.status === "crit").length,
    invalid:    hosts.filter(h => h.status === "invalid").length,
    warn:       hosts.filter(h => h.status === "warn").length,
    unknown:    hosts.filter(h => h.status === "unknown").length,
    suppressed: hosts.filter(h => h.status === "suppressed").length,
    ok:         hosts.filter(h => h.status === "ok").length,
  };

  const sorted = sortWorstFirst(hosts).filter(h => {
    if (cardFilter === "nongreen")   return h.status !== "ok" && h.status !== "suppressed";
    if (cardFilter === "crit")       return h.status === "crit";
    if (cardFilter === "invalid")    return h.status === "invalid";
    if (cardFilter === "warn")       return h.status === "warn";
    if (cardFilter === "unknown")    return h.status === "unknown";
    if (cardFilter === "suppressed") return h.status === "suppressed";
    if (cardFilter === "ok")         return h.status === "ok";
    return true;
  });

  const rowStyle = (status: string) => {
    if (status === "crit")       return { borderLeft: "3px solid #7f1d1d", background: "rgba(248,113,113,0.04)" };
    if (status === "invalid")    return { borderLeft: "3px solid #9a3412", background: "rgba(249,115,22,0.04)"  };
    if (status === "warn")       return { borderLeft: "3px solid #854d0e", background: "rgba(245,158,11,0.04)"  };
    if (status === "unknown")    return { borderLeft: "3px solid #6b21a8", background: "rgba(168,85,247,0.04)"  };
    if (status === "suppressed") return { borderLeft: "3px solid #1e3a5f", background: "rgba(96,165,250,0.04)"  };
    return { borderLeft: "3px solid transparent", background: "transparent" };
  };

  if (selected) return (
    <>
      <HostDetail host={selected} user={user} onBack={() => setSelected(null)} onRemoved={() => { setSelected(null); load(); }} />
    </>
  );

  return (
    <div className="app">
      <div className="stat-row">
        {[
          { label: "Non-green",  value: counts.nonGreen,   color: "color-crit",       filter: "nongreen"   },
          { label: "Critical",   value: counts.crit,        color: "color-crit",       filter: "crit"       },
          { label: "Invalid",    value: counts.invalid,     color: "color-invalid",    filter: "invalid"    },
          { label: "Warning",    value: counts.warn,        color: "color-warn",       filter: "warn"       },
          { label: "Unknown",    value: counts.unknown,     color: "color-unknown",    filter: "unknown"    },
          { label: "Suppressed", value: counts.suppressed,  color: "color-suppressed", filter: "suppressed" },
          { label: "Healthy",    value: counts.ok,          color: "color-ok",         filter: "ok"         },
        ].map(s => (
          <div key={s.label} className={`stat-card ${cardFilter === s.filter ? "stat-card-active" : ""}`}
            onClick={() => setCardFilter(cardFilter === s.filter ? null : s.filter)} style={{ cursor: "pointer" }}>
            <div className="stat-label">{s.label}</div>
            <div className={`stat-value ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <div className="table-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>
            All hosts — worst first
            {cardFilter && (
              <span style={{ fontSize: 12, color: "#8b8fa8", marginLeft: 8 }}>
                filtering: {cardFilter}
                <button onClick={() => setCardFilter(null)} style={{ marginLeft: 6, background: "none", border: "none", color: "#60a5fa", cursor: "pointer", fontSize: 12 }}>clear</button>
              </span>
            )}
          </span>
          <span style={{ fontSize: 12, color: "#555870", fontWeight: 400 }}>refreshes in {countdown}s</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Hostname</th>
              <th>Status</th>
              <th>Group</th>
              <th>Non-green checks</th>
              <th>Last seen</th>
              {userIsAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map(host => (
              <tr key={host.hostname} className="host-row" style={rowStyle(host.status)} onClick={() => setSelected(host)}>
                <td><div className="host-name">{host.hostname}</div>{host.ip && <div className="host-ip">{host.ip}</div>}</td>
                <td><StatusBadge status={host.status} /></td>
                <td className="color-muted">{host.group}</td>
                <td><CheckPills checks={host.checks} onlyNonGreen={true} /></td>
                <td className="color-faint">
                  {relativeTime(host.lastSeen)}
                  {host.lastError && (
                    <div style={{ fontSize: 12, color: "#f87171", marginTop: 2 }}>⚠ {host.lastError}</div>
                  )}
                </td>
                {userIsAdmin && (
                  <td style={{ width: 160 }}>
                    <RemoveButton label="Remove host" onConfirm={() => removeHost(host.hostname)} />
                  </td>
                )}
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={userIsAdmin ? 6 : 5} style={{ padding: "20px 16px", textAlign: "center", color: "#555870", fontSize: 13 }}>No hosts match this filter</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────

function DownloadAgent() {
  const platforms = [
    { label: "Windows (x64)",        binary: "nomyx-agent-win-x64.exe", configOs: "windows" },
    { label: "Linux (x64)",          binary: "nomyx-agent-linux-x64",   configOs: "linux"   },
    { label: "Raspberry Pi (arm64)", binary: "nomyx-agent-linux-arm64", configOs: "linux"   },
  ];
  return (
    <div className="app">
      <div className="um-page-title">Download Agent</div>
      <div className="um-page-sub">Install a monitoring agent on any host. Download the binary for the platform plus its pre-filled config, drop both in one folder, and run the binary — no editing. The config already points at this server and carries a fresh token.</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 580, marginTop: 14 }}>
        {platforms.map(p => (
          <div key={p.binary} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8 }}>
            <span style={{ fontWeight: 600 }}>{p.label}</span>
            <span style={{ display: "flex", gap: 8 }}>
              <a className="um-add-btn" href={`/agent/${p.binary}`} download>Binary</a>
              <a className="um-add-btn" href={`/api/agent/config?os=${p.configOs}`}>Config</a>
            </span>
          </div>
        ))}
      </div>

      <div className="um-page-sub" style={{ marginTop: 18, maxWidth: 580 }}>
        <strong>To run:</strong> put the binary and <code>config.json</code> in the same folder. Windows: run the .exe. Linux/Pi: <code>chmod +x</code> the binary, then run it. The host reports within a few minutes. Want extra metrics? Edit <code>config.json</code> and restart.
      </div>
    </div>
  );
}

function AuditLog() {
  const [rows,    setRows]    = useState<any[]>([]);
  const [search,  setSearch]  = useState("");
  const [action,  setAction]  = useState("");
  const [loading, setLoading] = useState(true);

  const load = () => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (action) params.set("action", action);
    fetch(`/api/audit?${params.toString()}`)
      .then(r => r.ok ? r.json() : [])
      .then(d => { setRows(Array.isArray(d) ? d : []); setLoading(false); });
  };

  // Re-query on filter change (debounced) and on mount.
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [search, action]);

  const actions = [...new Set(rows.map(r => r.action))].sort();
  const hasFilters = search || action;

  return (
    <div className="app">
      <div className="um-page-title">Audit log</div>
      <div className="um-page-sub">A record of administrative and security-relevant actions — sign-ins, account changes, template and host edits, and settings updates.</div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <input className="um-input" style={{ maxWidth: 280 }} placeholder="Search actor, target, or details…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="um-inline-select" style={{ width: 200 }} value={action} onChange={e => setAction(e.target.value)}>
          <option value="">All actions</option>
          {actions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        {hasFilters && (
          <button className="event-filter-clear" onClick={() => { setSearch(""); setAction(""); }}>Clear</button>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ padding: "20px 16px", textAlign: "center", color: "#555870" }}>Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: "20px 16px", textAlign: "center", color: "#555870" }}>
                {hasFilters ? "No entries match these filters" : "No audit entries yet"}
              </td></tr>
            ) : rows.map(r => (
              <tr key={r.id}>
                <td style={{ whiteSpace: "nowrap", color: "#8b8fa8" }}>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.actor}</td>
                <td><span className="audit-action">{r.action}</span></td>
                <td>{r.target ?? "—"}</td>
                <td style={{ color: "#8b8fa8" }}>{r.details ?? "—"}</td>
                <td style={{ color: "#555870" }}>{r.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


export default function App() {
  const [user,        setUser]        = useState<any>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.user) setUser(data.user); setAuthChecked(true); })
      .catch(() => setAuthChecked(true));
  }, []);

  if (!authChecked) return null;

  if (!user) return (
    <Routes>
      <Route path="/"              element={<Login onLogin={setUser} />} />
      <Route path="/auth/callback" element={<AuthCallback onLogin={setUser} />} />
    </Routes>
  );

  return (
    <>
      <Header user={user} setUser={setUser} />
      <Routes>
      <Route path="/"                             element={<Dashboard user={user} setUser={setUser} />} />
      <Route path="/noc"                          element={<NocView   user={user} setUser={setUser} />} />
      <Route path="/users"                        element={<Users currentUserId={user.id} />} />
      <Route path="/settings"                       element={<Settings />} />
      <Route path="/templates"                       element={<Templates user={user} />} />
      <Route path="/audit"                        element={<AuditLog />} />
      <Route path="/get-agent"                    element={<DownloadAgent />} />
      <Route path="/history/:hostname/:checkName" element={<History />} />
      </Routes>
    </>
  );
}