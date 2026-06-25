import { useState, useEffect } from "react";

interface OrgDivision {
  name:        string;
  slug:        string;
  departments: { name: string; slug: string }[];
}

interface OrgConfig {
  name:      string;
  divisions: OrgDivision[];
}

interface CheckConfig {
  name:          string;
  command:       string;
  unit:          string;
  warn?:         number | string;
  crit?:         number | string;
  thresholdDir?: string;
}

interface Template {
  id:          number;
  name:        string;
  description: string;
  division:    string | null;
  department:  string | null;
  checks:      CheckConfig[];
  createdBy:   string;
  createdAt:   string;
  updatedAt:   string | null;
}

const BLANK_CHECK: CheckConfig = {
  name: "", command: "", unit: "%", warn: 80, crit: 90, thresholdDir: "above"
};

function downloadJson(filename: string, data: object) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Check builder ──────────────────────────────────────────────────────────────

function CheckBuilder({ checks, onChange }: { checks: CheckConfig[]; onChange: (c: CheckConfig[]) => void }) {
  const update = (i: number, field: keyof CheckConfig, val: any) => {
    onChange(checks.map((c, idx) => idx === i ? { ...c, [field]: val } : c));
  };
  const remove = (i: number) => onChange(checks.filter((_, idx) => idx !== i));
  const add    = () => onChange([...checks, { ...BLANK_CHECK }]);

  return (
    <div className="tpl-checks">
      {checks.length === 0 && (
        <div className="tpl-checks-empty">No checks yet — add one below.</div>
      )}
      {checks.map((c, i) => (
        <div key={i} className="tpl-check-row">
          <div className="tpl-check-header">
            <span className="tpl-check-num">Check {i + 1}</span>
            <button className="um-delete-btn" onClick={() => remove(i)}>Remove</button>
          </div>
          <div className="tpl-check-fields">
            <div className="tpl-check-field">
              <label className="um-label">Name</label>
              <input className="um-input" placeholder="cpu" value={c.name}
                onChange={e => update(i, "name", e.target.value)} />
            </div>
            <div className="tpl-check-field">
              <label className="um-label">Unit</label>
              <input className="um-input" placeholder="%" value={c.unit}
                onChange={e => update(i, "unit", e.target.value)} />
            </div>
            <div className="tpl-check-field">
              <label className="um-label">Warn</label>
              <input className="um-input" type="number" placeholder="80" value={c.warn ?? ""}
                onChange={e => update(i, "warn", parseFloat(e.target.value))} />
            </div>
            <div className="tpl-check-field">
              <label className="um-label">Crit</label>
              <input className="um-input" type="number" placeholder="90" value={c.crit ?? ""}
                onChange={e => update(i, "crit", parseFloat(e.target.value))} />
            </div>
            <div className="tpl-check-field">
              <label className="um-label">Direction</label>
              <select className="um-input" value={c.thresholdDir ?? "above"}
                onChange={e => update(i, "thresholdDir", e.target.value)}>
                <option value="above">above (high = bad)</option>
                <option value="below">below (low = bad)</option>
              </select>
            </div>
          </div>
          <div className="tpl-check-field" style={{ marginTop: 6 }}>
            <label className="um-label">Command</label>
            <input className="um-input tpl-command-input" placeholder='powershell -command "..."'
              value={c.command} onChange={e => update(i, "command", e.target.value)} />
          </div>
        </div>
      ))}
      <button className="tpl-add-check-btn" onClick={add}>+ Add check</button>
    </div>
  );
}

// ── Template form ──────────────────────────────────────────────────────────────

function TemplateForm({
  initial, org, onSave, onCancel
}: {
  initial?:  Template;
  org:       OrgConfig | null;
  onSave:    () => void;
  onCancel:  () => void;
}) {
  const [name,        setName]        = useState(initial?.name        ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [division,    setDivision]    = useState(initial?.division    ?? "");
  const [department,  setDepartment]  = useState(initial?.department  ?? "");
  const [checks,      setChecks]      = useState<CheckConfig[]>(initial?.checks ?? []);
  const [error,       setError]       = useState("");
  const [saving,      setSaving]      = useState(false);

  const selectedDiv = org?.divisions.find(d => d.name === division);

  const save = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true); setError("");
    const url    = initial ? `/api/templates/${initial.id}` : "/api/templates";
    const method = initial ? "PATCH" : "POST";
    const res = await fetch(url, {
      method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, division: division || null, department: department || null, checks }),
    });
    setSaving(false);
    if (!res.ok) { const d = await res.json(); setError(d.error ?? "Failed to save"); return; }
    onSave();
  };

  return (
    <div className="tpl-form-wrap">
      <div className="settings-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div className="settings-card-title" style={{ margin: 0 }}>{initial ? "Edit template" : "New template"}</div>
          <button className="confirm-cancel-btn" onClick={onCancel}>Cancel</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div className="um-field" style={{ margin: 0 }}>
            <label className="um-label">Name</label>
            <input className="um-input" placeholder="Windows Server — Standard" value={name}
              onChange={e => setName(e.target.value)} />
          </div>
          <div className="um-field" style={{ margin: 0 }}>
            <label className="um-label">Description <span className="um-optional">(optional)</span></label>
            <input className="um-input" placeholder="Standard checks for Windows servers" value={description}
              onChange={e => setDescription(e.target.value)} />
          </div>
          <div className="um-field" style={{ margin: 0 }}>
            <label className="um-label">Division <span className="um-optional">(optional)</span></label>
            <select className="um-input" value={division} onChange={e => { setDivision(e.target.value); setDepartment(""); }}>
              <option value="">— All divisions —</option>
              {org?.divisions.map(d => <option key={d.slug} value={d.name}>{d.name}</option>)}
            </select>
          </div>
          <div className="um-field" style={{ margin: 0 }}>
            <label className="um-label">Department <span className="um-optional">(optional)</span></label>
            <select className="um-input" value={department} onChange={e => setDepartment(e.target.value)} disabled={!division}>
              <option value="">— All departments —</option>
              {selectedDiv?.departments.map(d => <option key={d.slug} value={d.name}>{d.name}</option>)}
            </select>
          </div>
        </div>

        <div className="um-label" style={{ marginBottom: 8 }}>Checks</div>
        <CheckBuilder checks={checks} onChange={setChecks} />

        {error && <div className="um-error" style={{ marginTop: 10 }}>{error}</div>}

        <div style={{ marginTop: 14 }}>
          <button className="um-submit-btn" style={{ width: "auto", padding: "9px 24px" }}
            onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : initial ? "Save changes" : "Create template"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Templates({ user }: { user?: any }) {
  const [templates,  setTemplates]  = useState<Template[]>([]);
  const [org,        setOrg]        = useState<OrgConfig | null>(null);
  const [editing,    setEditing]    = useState<Template | null | "new">(null);
  const [success,    setSuccess]    = useState("");
  const [confirmDel, setConfirmDel] = useState<number | null>(null);

  const userIsAdmin = ["global_admin", "admin"].includes(user?.role);
  const [filterDiv,  setFilterDiv]  = useState("");
  const [filterDept, setFilterDept] = useState("");

  const load = () => {
    fetch("/api/templates").then(r => r.json()).then(setTemplates);
    fetch("/api/org").then(r => r.json()).then(setOrg);
  };

  useEffect(() => { load(); }, []);

  const deleteTemplate = async (id: number) => {
    await fetch(`/api/templates/${id}`, { method: "DELETE" });
    setConfirmDel(null); load();
  };

  const download = (t: Template) => {
    const cfg = {
      host:            "YOUR_HOSTNAME",
      group:           t.division ?? "default",
      division:        t.division   ?? undefined,
      department:      t.department ?? undefined,
      token:           "YOUR_TOKEN",
      serverUrl:       "http://YOUR_SERVER:4433",
      intervalSeconds: 60,
      checks:          t.checks,
    };
    downloadJson(`nomyx-${t.name.toLowerCase().replace(/\s+/g, "-")}.json`, cfg);
  };

  return (
    <div className="app">
      <div className="um-page-title">Config templates</div>
      <div className="um-page-sub">Create reusable agent configurations. Download a template to deploy a new host quickly.</div>

      {success && <div className="um-success">{success}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Form — shown when creating or editing, admins only */}
        {editing !== null && userIsAdmin && (
          <TemplateForm
            initial={editing === "new" ? undefined : editing as Template}
            org={org}
            onSave={() => {
              setSuccess(editing === "new" ? "Template created" : "Template saved");
              setTimeout(() => setSuccess(""), 3000);
              setEditing(null); load();
            }}
            onCancel={() => setEditing(null)}
          />
        )}

        {/* Template list */}
        <div>
          {/* Filter bar */}
          {templates.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <select className="um-inline-select" style={{ width: 160 }} value={filterDiv}
                onChange={e => { setFilterDiv(e.target.value); setFilterDept(""); }}>
                <option value="">— All divisions —</option>
                {[...new Set(templates.filter(t => t.division).map(t => t.division!))].map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <select className="um-inline-select" style={{ width: 180 }} value={filterDept}
                onChange={e => setFilterDept(e.target.value)} disabled={!filterDiv}>
                <option value="">— All departments —</option>
                {[...new Set(templates.filter(t => t.division === filterDiv && t.department).map(t => t.department!))].map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              {(filterDiv || filterDept) && (
                <button className="event-filter-clear" onClick={() => { setFilterDiv(""); setFilterDept(""); }}>
                  Clear
                </button>
              )}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div className="um-section-title" style={{ margin: 0 }}>
              {(() => {
                const count = templates.filter(t => {
                  if (filterDiv  && t.division   !== filterDiv)  return false;
                  if (filterDept && t.department !== filterDept) return false;
                  return true;
                }).length;
                return `${count} template${count !== 1 ? "s" : ""}${filterDiv ? " (filtered)" : ""}`;
              })()}
            </div>
            {editing === null && userIsAdmin && (
              <button className="um-add-btn" style={{ padding: "5px 14px" }} onClick={() => setEditing("new")}>
                + New template
              </button>
            )}
          </div>

          {templates.length === 0 && editing === null && (
            <div className="table-wrap">
              <div className="um-empty" style={{ padding: "32px 16px" }}>
                No templates yet — click "New template" to get started.
              </div>
            </div>
          )}

          {templates.filter(t => {
            if (filterDiv  && t.division  !== filterDiv)  return false;
            if (filterDept && t.department !== filterDept) return false;
            return true;
          }).map(t => (
            <div key={t.id} className="tpl-card">
              <div className="tpl-card-header">
                <div>
                  <div className="tpl-name">{t.name}</div>
                  {t.description && <div className="tpl-desc">{t.description}</div>}
                  <div className="tpl-meta">
                    {t.division && (
                      <span className="um-scope-tag">
                        {t.division}{t.department ? ` / ${t.department}` : ""}
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: "#555870" }}>
                      {t.checks.length} check{t.checks.length !== 1 ? "s" : ""} · by {t.createdBy}
                    </span>
                  </div>
                </div>
                <div className="tpl-card-actions">
                  <button className="settings-run-btn" onClick={() => download(t)}>↓ Download</button>
                  {userIsAdmin && (
                    <button className="um-edit-btn" onClick={() => { setEditing(t); setConfirmDel(null); }}>Edit</button>
                  )}
                  {userIsAdmin && (
                    <div className="remove-host-cell">
                      {confirmDel === t.id ? (
                        <div className="confirm-inline">
                          <button className="confirm-danger-btn" onClick={() => void deleteTemplate(t.id)}>Delete</button>
                          <button className="confirm-cancel-btn" onClick={() => setConfirmDel(null)}>Cancel</button>
                        </div>
                      ) : (
                        <button className="um-delete-btn" onClick={() => setConfirmDel(t.id)}>Delete</button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {t.checks.length > 0 && (
                <div className="tpl-checks-preview">
                  {t.checks.map((c, i) => (
                    <div key={i} className="tpl-check-preview-item">
                      <div className="tpl-check-preview-top">
                        <span className="tpl-check-preview-name">{c.name}</span>
                        <span className="tpl-check-preview-meta">
                          {c.unit} · warn {c.warn} · crit {c.crit} · {c.thresholdDir ?? "above"}
                        </span>
                      </div>
                      {c.command && <code className="tpl-check-preview-cmd" title={c.command}>{c.command}</code>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}