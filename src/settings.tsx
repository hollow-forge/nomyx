import { useState, useEffect } from "react";

interface RetentionSettings {
  raw_retention_days:    number;
  fivemin_retention_days: number;
  hourly_retention_days:  number;
  daily_retention_years:  number;
  event_log_retention_days: number;
  audit_log_retention_days: number;
}

interface DbStats {
  totalRows:   number;
  oldestEvent: string | null;
  hostCount:   number;
}

interface AgentToken {
  id:          number;
  label:       string;
  createdBy:   string;
  createdAt:   string;
  lastUsedAt:  string | null;
}

function SettingRow({
  label, description, value, unit, min, max, onChange
}: {
  label:       string;
  description: string;
  value:       number;
  unit:        string;
  min:         number;
  max:         number;
  onChange:    (v: number) => void;
}) {
  // Hold a local text draft so the field can be cleared and retyped freely.
  // We only clamp/commit on blur or Enter — never on every keystroke — so the
  // value no longer snaps back to the minimum the instant the box goes empty.
  const [draft, setDraft] = useState(String(value));

  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const n = parseInt(draft, 10);
    if (isNaN(n)) { setDraft(String(value)); return; }   // blank/garbage → revert to last good
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div className="setting-row">
      <div className="setting-info">
        <div className="setting-label">{label}</div>
        <div className="setting-desc">{description}</div>
      </div>
      <div className="setting-control">
        <input
          type="text"
          inputMode="numeric"
          className="setting-input"
          value={draft}
          onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
        <span className="setting-unit">{unit}</span>
      </div>
    </div>
  );
}

export default function Settings() {
  const [retention, setRetention] = useState<RetentionSettings>({
    raw_retention_days:     7,
    fivemin_retention_days: 90,
    hourly_retention_days:  730,
    daily_retention_years:  5,
    event_log_retention_days: 365,
    audit_log_retention_days: 365,
  });
  // Snapshot of what's currently persisted, so we can detect unsaved edits.
  const [savedRetention, setSavedRetention] = useState<RetentionSettings>({
    raw_retention_days:     7,
    fivemin_retention_days: 90,
    hourly_retention_days:  730,
    daily_retention_years:  5,
    event_log_retention_days: 365,
    audit_log_retention_days: 365,
  });
  const [stats,   setStats]   = useState<DbStats | null>(null);
  const [saving,  setSaving]  = useState(false);
  const [success, setSuccess] = useState("");
  const [error,   setError]   = useState("");
  const [lastRun,    setLastRun]    = useState<string | null>(null);
  const [tokens,     setTokens]     = useState<AgentToken[]>([]);
  const [newTokenLabel, setNewTokenLabel] = useState("");
  const [newToken,   setNewToken]   = useState<string | null>(null);
  const [tokenError, setTokenError] = useState("");

  // Alert settings
  const [alertEmailEnabled,  setAlertEmailEnabled]  = useState(false);
  const [alertEmailTo,       setAlertEmailTo]        = useState("");
  const [alertEmailFrom,     setAlertEmailFrom]      = useState("nomyx@localhost");
  const [alertSmtpHost,      setAlertSmtpHost]       = useState("");
  const [alertSmtpPort,      setAlertSmtpPort]       = useState("25");
  const [alertTeamsEnabled,  setAlertTeamsEnabled]   = useState(false);
  const [alertTeamsWebhook,  setAlertTeamsWebhook]   = useState("");
  const [alertOnCrit,        setAlertOnCrit]         = useState(true);
  const [alertOnUnknown,     setAlertOnUnknown]      = useState(true);
  const [alertOnRecovery,    setAlertOnRecovery]     = useState(true);
  const [alertOnWarn,        setAlertOnWarn]         = useState(false);
  const [alertSaving,        setAlertSaving]         = useState(false);
  const [alertSuccess,       setAlertSuccess]        = useState("");
  const [alertError,         setAlertError]          = useState("");

  const load = () => {
    fetch("/api/settings").then(r => r.json()).then((data: Record<string, string>) => {
      const loaded: RetentionSettings = {
        raw_retention_days:     parseInt(data.raw_retention_days)     || 7,
        fivemin_retention_days: parseInt(data.fivemin_retention_days) || 90,
        hourly_retention_days:  parseInt(data.hourly_retention_days)  || 730,
        daily_retention_years:  parseInt(data.daily_retention_years)  || 5,
        event_log_retention_days: parseInt(data.event_log_retention_days) || 365,
        audit_log_retention_days: parseInt(data.audit_log_retention_days) || 365,
      };
      setRetention(loaded);
      setSavedRetention(loaded);
      setLastRun(data.last_rollup_run ?? null);
    });
    fetch("/api/settings/stats").then(r => r.json()).then(setStats);
    fetch("/api/agent-tokens").then(r => r.json()).then(setTokens);
    fetch("/api/settings").then(r => r.json()).then((data: Record<string, string>) => {
      setAlertEmailEnabled(data.alert_email_enabled === "1");
      setAlertEmailTo(data.alert_email_to ?? "");
      setAlertEmailFrom(data.alert_email_from ?? "nomyx@localhost");
      setAlertSmtpHost(data.alert_smtp_host ?? "");
      setAlertSmtpPort(data.alert_smtp_port ?? "25");
      setAlertTeamsEnabled(data.alert_teams_enabled === "1");
      setAlertTeamsWebhook(data.alert_teams_webhook ?? "");
      setAlertOnCrit(data.alert_on_crit !== "0");
      setAlertOnUnknown(data.alert_on_unknown !== "0");
      setAlertOnRecovery(data.alert_on_recovery !== "0");
      setAlertOnWarn(data.alert_on_warn === "1");
    });
  };

  useEffect(() => { load(); }, []);

  const retentionDirty = JSON.stringify(retention) !== JSON.stringify(savedRetention);

  const save = async () => {
    setSaving(true); setError(""); setSuccess("");
    const res = await fetch("/api/settings", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        raw_retention_days:     String(retention.raw_retention_days),
        fivemin_retention_days: String(retention.fivemin_retention_days),
        hourly_retention_days:  String(retention.hourly_retention_days),
        daily_retention_years:  String(retention.daily_retention_years),
        event_log_retention_days: String(retention.event_log_retention_days),
        audit_log_retention_days: String(retention.audit_log_retention_days),
      }),
    });
    setSaving(false);
    if (!res.ok) { setError("Failed to save settings"); return; }
    setSavedRetention(retention);
    setSuccess("Settings saved"); setTimeout(() => setSuccess(""), 3000);
  };

  const runRollup = async () => {
    setSaving(true); setError(""); setSuccess("");
    const res = await fetch("/api/settings/rollup", { method: "POST" });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError("Rollup failed"); return; }
    setSuccess(`Rollup complete — ${data.deleted} rows compacted`);
    setTimeout(() => setSuccess(""), 5000);
    load();
  };

  const saveAlerts = async () => {
    setAlertSaving(true); setAlertError(""); setAlertSuccess("");
    const res = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alert_email_enabled:  alertEmailEnabled  ? "1" : "0",
        alert_email_to:       alertEmailTo,
        alert_email_from:     alertEmailFrom,
        alert_smtp_host:      alertSmtpHost,
        alert_smtp_port:      alertSmtpPort,
        alert_teams_enabled:  alertTeamsEnabled  ? "1" : "0",
        alert_teams_webhook:  alertTeamsWebhook,
        alert_on_crit:        alertOnCrit        ? "1" : "0",
        alert_on_unknown:     alertOnUnknown     ? "1" : "0",
        alert_on_recovery:    alertOnRecovery    ? "1" : "0",
        alert_on_warn:        alertOnWarn        ? "1" : "0",
      }),
    });
    setAlertSaving(false);
    if (!res.ok) { setAlertError("Failed to save alert settings"); return; }
    setAlertSuccess("Alert settings saved"); setTimeout(() => setAlertSuccess(""), 3000);
  };

  const testEmail = async () => {
    setAlertError(""); setAlertSuccess("");
    const res = await fetch("/api/settings/test-email", { method: "POST" });
    const data = await res.json();
    if (!res.ok) { setAlertError(data.error ?? "Test email failed"); return; }
    setAlertSuccess("Test email sent — check your inbox");
    setTimeout(() => setAlertSuccess(""), 5000);
  };

  const testTeams = async () => {
    setAlertError(""); setAlertSuccess("");
    const res = await fetch("/api/settings/test-teams", { method: "POST" });
    const data = await res.json();
    if (!res.ok) { setAlertError(data.error ?? "Test Teams message failed"); return; }
    setAlertSuccess("Test Teams message sent");
    setTimeout(() => setAlertSuccess(""), 5000);
  };

  return (
    <div className="app">
      <div className="um-page-title">Settings</div>
      <div className="um-page-sub">Configure data retention and system behaviour.</div>

      {success && <div className="um-success">{success}</div>}
      {error   && <div className="um-error">{error}</div>}

      <div className="settings-layout">
        <div className="settings-left">

          {/* ── Data retention ── */}
          <div className="settings-card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div className="settings-card-title">Data retention</div>
              {retentionDirty && (
                <span style={{ fontSize: 11, color: "#f59e0b", fontWeight: 500, whiteSpace: "nowrap" }}>
                  ● Unsaved changes
                </span>
              )}
            </div>
            <div className="settings-card-sub">
              Controls how long check history is kept before being rolled up into lower-resolution buckets,
              and how long the status-change event log is retained. Notes are never deleted.
            </div>

            <div className="settings-tier-label">Full resolution (raw check-ins)</div>
            <SettingRow
              label="Raw data"
              description="Keep every individual check-in at full resolution"
              value={retention.raw_retention_days}
              unit="days"
              min={1} max={365}
              onChange={v => setRetention(r => ({ ...r, raw_retention_days: v }))}
            />

            <div className="settings-tier-label" style={{ marginTop: 16 }}>5-minute buckets</div>
            <SettingRow
              label="5-min rollup"
              description="After raw retention expires, keep 5-minute aggregated buckets"
              value={retention.fivemin_retention_days}
              unit="days"
              min={retention.raw_retention_days + 1} max={3650}
              onChange={v => setRetention(r => ({ ...r, fivemin_retention_days: v }))}
            />

            <div className="settings-tier-label" style={{ marginTop: 16 }}>Hourly buckets</div>
            <SettingRow
              label="Hourly rollup"
              description="After 5-min retention expires, keep hourly aggregated buckets"
              value={retention.hourly_retention_days}
              unit="days"
              min={retention.fivemin_retention_days + 1} max={36500}
              onChange={v => setRetention(r => ({ ...r, hourly_retention_days: v }))}
            />

            <div className="settings-tier-label" style={{ marginTop: 16 }}>Daily buckets (long-term)</div>
            <SettingRow
              label="Daily rollup"
              description="After hourly retention expires, keep daily aggregated buckets indefinitely"
              value={retention.daily_retention_years}
              unit="years"
              min={1} max={99}
              onChange={v => setRetention(r => ({ ...r, daily_retention_years: v }))}
            />

            <div className="settings-tier-label" style={{ marginTop: 16 }}>Event log (status changes)</div>
            <SettingRow
              label="Event log"
              description="Keep status-change events this long, then delete the oldest. Notes are never deleted."
              value={retention.event_log_retention_days}
              unit="days"
              min={1} max={36500}
              onChange={v => setRetention(r => ({ ...r, event_log_retention_days: v }))}
            />

            <div className="settings-tier-label" style={{ marginTop: 16 }}>Audit log (admin actions)</div>
            <SettingRow
              label="Audit log"
              description="Keep audit entries (sign-ins, account and config changes) this long, then delete the oldest."
              value={retention.audit_log_retention_days}
              unit="days"
              min={1} max={36500}
              onChange={v => setRetention(r => ({ ...r, audit_log_retention_days: v }))}
            />

            <div className="settings-note">
              Worst status wins during rollup — if a metric went critical for 3 minutes in an hour, that hour shows as critical.
              Bar chart resolution changes as you zoom out; the event log always shows exact timestamps.
            </div>

            <button className="um-submit-btn" style={{ marginTop: 16, width: "auto", padding: "9px 24px" }} onClick={() => void save()} disabled={saving || !retentionDirty}>
              {saving ? "Saving…" : retentionDirty ? "Save retention settings" : "Saved"}
            </button>
          </div>

          {/* ── Manual rollup ── */}
          <div className="settings-card" style={{ marginTop: 16 }}>
            <div className="settings-card-title">Data rollup</div>
            <div className="settings-card-sub">
              Rollup runs automatically every night at 2am. You can also trigger it manually here.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
              <button className="settings-run-btn" onClick={() => void runRollup()} disabled={saving}>
                {saving ? "Running…" : "Run rollup now"}
              </button>
              {lastRun && (
                <span style={{ fontSize: 11, color: "#555870" }}>
                  Last run: {new Date(lastRun).toLocaleString()}
                </span>
              )}
            </div>
          </div>

          {/* ── Agent tokens ── */}
          <div className="settings-card" style={{ marginTop: 16 }}>
            <div className="settings-card-title">Agent tokens</div>
            <div className="settings-card-sub">
              Tokens authenticate agents posting to /api/status. Add the token to each agent's config.json.
            </div>

            {tokens.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {tokens.map(t => (
                  <div key={t.id} className="token-row">
                    <div className="token-info">
                      <div className="token-label">{t.label}</div>
                      <div className="token-meta">
                        Created by {t.createdBy} · {new Date(t.createdAt).toLocaleDateString()}
                        {t.lastUsedAt && ` · Last used ${new Date(t.lastUsedAt).toLocaleString()}`}
                      </div>
                    </div>
                    <button className="um-delete-btn" onClick={async () => {
                      await fetch(`/api/agent-tokens/${t.id}`, { method: "DELETE" });
                      load();
                    }}>Revoke</button>
                  </div>
                ))}
              </div>
            )}

            {newToken && (
              <div className="token-reveal">
                <div className="token-reveal-label">Copy this token now — it won't be shown again:</div>
                <div className="token-reveal-value">{newToken}</div>
                <button className="confirm-cancel-btn" onClick={() => setNewToken(null)} style={{ marginTop: 8 }}>Done</button>
              </div>
            )}

            {!newToken && (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <label className="um-label">Token label</label>
                  <input
                    className="um-input"
                    placeholder="e.g. Production agents"
                    value={newTokenLabel}
                    onChange={e => setNewTokenLabel(e.target.value)}
                  />
                </div>
                <button className="settings-run-btn" onClick={async () => {
                  if (!newTokenLabel.trim()) { setTokenError("Label is required"); return; }
                  setTokenError("");
                  const res = await fetch("/api/agent-tokens", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ label: newTokenLabel }),
                  });
                  const data = await res.json();
                  if (!res.ok) { setTokenError(data.error ?? "Failed"); return; }
                  setNewToken(data.token);
                  setNewTokenLabel("");
                  load();
                }}>Generate token</button>
              </div>
            )}
            {tokenError && <div className="um-error" style={{ marginTop: 8 }}>{tokenError}</div>}
          </div>

          {/* ── Alerting ── */}
          <div className="settings-card" style={{ marginTop: 16 }}>
            <div className="settings-card-title">Alerting</div>
            <div className="settings-card-sub">
              Send notifications on status changes. Alerts fire when a check transitions between states.
            </div>

            {alertSuccess && <div className="um-success">{alertSuccess}</div>}
            {alertError   && <div className="um-error">{alertError}</div>}

            {/* Trigger selection */}
            <div className="settings-tier-label">Alert triggers</div>
            <div className="alert-triggers">
              {[
                { label: "Goes critical",    checked: alertOnCrit,     set: setAlertOnCrit     },
                { label: "Goes unknown",     checked: alertOnUnknown,  set: setAlertOnUnknown  },
                { label: "Recovers to OK",   checked: alertOnRecovery, set: setAlertOnRecovery },
                { label: "Goes warning",     checked: alertOnWarn,     set: setAlertOnWarn     },
              ].map(t => (
                <label key={t.label} className="alert-trigger-row">
                  <input type="checkbox" checked={t.checked} onChange={e => t.set(e.target.checked)} />
                  <span>{t.label}</span>
                </label>
              ))}
            </div>

            {/* Email */}
            <div className="settings-tier-label" style={{ marginTop: 16 }}>Email (SMTP relay)</div>
            <label className="alert-trigger-row" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={alertEmailEnabled} onChange={e => setAlertEmailEnabled(e.target.checked)} />
              <span>Enable email alerts</span>
            </label>
            <div className="alert-fields">
              <div className="alert-field-group">
                <label className="um-label">SMTP host</label>
                <input className="um-input" placeholder="mail.company.com" value={alertSmtpHost} onChange={e => setAlertSmtpHost(e.target.value)} disabled={!alertEmailEnabled} />
              </div>
              <div className="alert-field-group alert-field-narrow">
                <label className="um-label">Port</label>
                <input className="um-input" placeholder="25" value={alertSmtpPort} onChange={e => setAlertSmtpPort(e.target.value)} disabled={!alertEmailEnabled} />
              </div>
            </div>
            <div className="alert-fields" style={{ marginTop: 8 }}>
              <div className="alert-field-group">
                <label className="um-label">From address</label>
                <input className="um-input" placeholder="nomyx@company.com" value={alertEmailFrom} onChange={e => setAlertEmailFrom(e.target.value)} disabled={!alertEmailEnabled} />
              </div>
              <div className="alert-field-group">
                <label className="um-label">To address(es)</label>
                <input className="um-input" placeholder="noc@company.com, ops@company.com" value={alertEmailTo} onChange={e => setAlertEmailTo(e.target.value)} disabled={!alertEmailEnabled} />
              </div>
            </div>
            <button className="settings-run-btn" style={{ marginTop: 8 }} onClick={() => void testEmail()} disabled={!alertEmailEnabled || !alertSmtpHost || !alertEmailTo}>
              Send test email
            </button>

            {/* Teams */}
            <div className="settings-tier-label" style={{ marginTop: 20 }}>Microsoft Teams</div>
            <label className="alert-trigger-row" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={alertTeamsEnabled} onChange={e => setAlertTeamsEnabled(e.target.checked)} />
              <span>Enable Teams alerts</span>
            </label>
            <div className="um-field">
              <label className="um-label">Incoming webhook URL</label>
              <input className="um-input" placeholder="https://outlook.office.com/webhook/..." value={alertTeamsWebhook} onChange={e => setAlertTeamsWebhook(e.target.value)} disabled={!alertTeamsEnabled} />
              <div className="um-hint">Create via Teams channel → Manage channel → Connectors → Incoming Webhook</div>
            </div>
            <button className="settings-run-btn" onClick={() => void testTeams()} disabled={!alertTeamsEnabled || !alertTeamsWebhook}>
              Send test Teams message
            </button>

            <div style={{ marginTop: 16 }}>
              <button className="um-submit-btn" style={{ width: "auto", padding: "9px 24px" }} onClick={() => void saveAlerts()} disabled={alertSaving}>
                {alertSaving ? "Saving…" : "Save alert settings"}
              </button>
            </div>
          </div>

        </div>

        {/* ── DB stats sidebar ── */}
        <div className="settings-sidebar">
          <div className="settings-card">
            <div className="settings-card-title">Database</div>
            {stats ? (
              <>
                <div className="settings-stat-row">
                  <span className="settings-stat-label">Hosts monitored</span>
                  <span className="settings-stat-value">{stats.hostCount}</span>
                </div>
                <div className="settings-stat-row">
                  <span className="settings-stat-label">History rows</span>
                  <span className="settings-stat-value">{stats.totalRows.toLocaleString()}</span>
                </div>
                <div className="settings-stat-row">
                  <span className="settings-stat-label">Oldest event</span>
                  <span className="settings-stat-value" style={{ fontSize: 10 }}>
                    {stats.oldestEvent ? new Date(stats.oldestEvent).toLocaleDateString() : "—"}
                  </span>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: "#555870" }}>Loading…</div>
            )}
          </div>

          <div className="settings-card" style={{ marginTop: 12 }}>
            <div className="settings-card-title">Retention summary</div>
            <div className="settings-retention-timeline">
              {[
                { label: "Raw",     days: retention.raw_retention_days,                      color: "#4ade80" },
                { label: "5-min",  days: retention.fivemin_retention_days,                   color: "#60a5fa" },
                { label: "Hourly", days: retention.hourly_retention_days,                    color: "#a855f7" },
                { label: "Daily",  days: retention.daily_retention_years * 365,              color: "#f59e0b" },
                { label: "Events", days: retention.event_log_retention_days,                 color: "#2dd4bf" },
                { label: "Audit",  days: retention.audit_log_retention_days,                  color: "#f472b6" },
              ].map(t => (
                <div key={t.label} className="settings-tier-row">
                  <div className="settings-tier-dot" style={{ background: t.color }} />
                  <span className="settings-tier-name">{t.label}</span>
                  <span className="settings-tier-val">
                    {t.days >= 365
                      ? `${(t.days / 365).toFixed(1)}y`
                      : `${t.days}d`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}