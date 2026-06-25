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

interface Scope {
  id?:        number;
  division:   string;
  department: string | null;
}

interface User {
  id:          number;
  email:       string;
  displayName: string;
  role:        string;
  authSource:  string;
  scopes:      Scope[];
  createdAt:   string;
  lastLogin:   string | null;
}

interface GroupMapping {
  id:        number;
  groupName: string;
  role:      string;
  scopes:    Scope[];
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s    = Math.floor(diff / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function scopeLabel(s: Scope): string {
  if (!s.department) return s.division;
  return `${s.division} / ${s.department}`;
}

function RoleBadge({ role }: { role: string }) {
  const cls: Record<string, string> = {
    global_admin: "um-badge-admin",
    admin:        "um-badge-admin",
    noc:          "um-badge-noc",
    operator:     "um-badge-operator",
    viewer:       "um-badge-viewer",
  };
  const lbl: Record<string, string> = {
    global_admin: "global admin",
    admin:        "admin",
    noc:          "noc",
    operator:     "operator",
    viewer:       "viewer",
  };
  return <span className={`um-badge ${cls[role] ?? "um-badge-viewer"}`}>{lbl[role] ?? role}</span>;
}

function AuthBadge({ source }: { source: string }) {
  const cls: Record<string, string> = { local: "um-auth-local", ldap: "um-auth-ldap", entra: "um-auth-entra" };
  return <span className={`um-auth ${cls[source] ?? "um-auth-local"}`}>{source}</span>;
}

function ScopeTags({ scopes }: { scopes: Scope[] }) {
  if (scopes.length === 0) return <span className="um-scope">all</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {scopes.map((s, i) => (
        <span key={i} className="um-scope-tag">{scopeLabel(s)}</span>
      ))}
    </div>
  );
}

// ── Inline confirm ─────────────────────────────────────────────────────────────

function InlineConfirm({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 11, color: "#f87171" }}>{confirmLabel}</span>
        <button className="confirm-danger-btn" onClick={() => { onConfirm(); setConfirming(false); }}>Yes, remove</button>
        <button className="confirm-cancel-btn" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    );
  }

  return (
    <button className="um-delete-btn" onClick={() => setConfirming(true)}>{label}</button>
  );
}

// ── Scope Builder ──────────────────────────────────────────────────────────────

function ScopeBuilder({
  scopes, org, onChange
}: {
  scopes:   Scope[];
  org:      OrgConfig | null;
  onChange: (scopes: Scope[]) => void;
}) {
  const [div,  setDiv]  = useState("");
  const [dept, setDept] = useState("");

  const selectedDiv = org?.divisions.find(d => d.name === div);

  const add = () => {
    if (!div) return;
    onChange([...scopes, { division: div, department: dept || null }]);
    setDiv(""); setDept("");
  };

  const remove = (i: number) => onChange(scopes.filter((_, idx) => idx !== i));

  return (
    <div className="um-scope-builder">
      {scopes.length > 0 && (
        <div className="um-scope-list">
          {scopes.map((s, i) => (
            <div key={i} className="um-scope-item">
              <span>{scopeLabel(s)}</span>
              <button className="um-scope-remove" onClick={() => remove(i)} title="Remove scope">🗑</button>
            </div>
          ))}
        </div>
      )}
      {scopes.length === 0 && (
        <div className="um-scope-empty">No scopes — this user will see all hosts.</div>
      )}
      <div className="um-scope-add-box">
        <div className="um-scope-add-row">
          <select className="um-input" value={div} onChange={e => { setDiv(e.target.value); setDept(""); }}>
            <option value="">— Division —</option>
            {org?.divisions.map(d => <option key={d.slug} value={d.name}>{d.name}</option>)}
          </select>
          <select className="um-input" value={dept} onChange={e => setDept(e.target.value)} disabled={!div}>
            <option value="">— Any department —</option>
            {selectedDiv?.departments.map(d => <option key={d.slug} value={d.name}>{d.name}</option>)}
          </select>
        </div>
        <button className="um-scope-add-btn" onClick={add} disabled={!div}>+ Add scope</button>
      </div>
    </div>
  );
}

// ── Edit user panel ────────────────────────────────────────────────────────────

function EditUserPanel({
  user, org, onSave, onCancel
}: {
  user:     User;
  org:      OrgConfig | null;
  onSave:   () => void;
  onCancel: () => void;
}) {
  const [name,   setName]   = useState(user.displayName);
  const [email,  setEmail]  = useState(user.email);
  const [role,   setRole]   = useState(user.role);
  const [scopes, setScopes] = useState<Scope[]>(user.scopes);
  const [error,  setError]  = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name || !email || !role) { setError("Name, email and role are required"); return; }
    setSaving(true); setError("");
    const res = await fetch(`/api/users/${user.id}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ displayName: name, email, role, scopes }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error ?? "Failed to save"); return; }
    onSave();
  };

  return (
    <div className="um-form">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div className="um-form-title" style={{ margin: 0 }}>Edit user</div>
        <button className="confirm-cancel-btn" onClick={onCancel}>Cancel</button>
      </div>

      <div style={{ fontSize: 10, color: "#555870", marginBottom: 12, padding: "6px 8px", background: "#151821", borderRadius: 6, border: "0.5px solid #2a2d35" }}>
        Auth: <AuthBadge source={user.authSource} />
        {user.authSource !== "local" && (
          <span style={{ marginLeft: 6, color: "#555870" }}>— role &amp; scopes may be overwritten on next login by group mappings</span>
        )}
      </div>

      <div className="um-field">
        <label className="um-label">Display name</label>
        <input className="um-input" type="text" value={name} onChange={e => setName(e.target.value)} />
      </div>
      <div className="um-field">
        <label className="um-label">Email</label>
        <input className="um-input" type="email" value={email} onChange={e => setEmail(e.target.value)} />
      </div>
      <div className="um-field">
        <label className="um-label">Role</label>
        <select className="um-input" value={role} onChange={e => setRole(e.target.value)}>
          <option value="viewer">viewer</option>
          <option value="operator">operator</option>
          <option value="noc">noc</option>
          <option value="admin">admin</option>
          <option value="global_admin">global admin</option>
        </select>
      </div>
      <div className="um-field">
        <label className="um-label">Scopes <span className="um-optional">(optional)</span></label>
        <ScopeBuilder scopes={scopes} org={org} onChange={setScopes} />
      </div>

      {error && <div className="um-error">{error}</div>}

      <button className="um-submit-btn" onClick={() => void save()} disabled={saving}>
        {saving ? "Saving…" : "Save changes"}
      </button>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Users({ currentUserId }: { currentUserId: number }) {
  const [users,      setUsers]      = useState<User[]>([]);
  const [mappings,   setMappings]   = useState<GroupMapping[]>([]);
  const [org,        setOrg]        = useState<OrgConfig | null>(null);
  const [success,    setSuccess]    = useState("");
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const [newName,     setNewName]     = useState("");
  const [newEmail,    setNewEmail]    = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole,     setNewRole]     = useState("viewer");
  const [newScopes,   setNewScopes]   = useState<Scope[]>([]);
  const [addError,    setAddError]    = useState("");

  const [mapGroup,  setMapGroup]  = useState("");
  const [mapRole,   setMapRole]   = useState("viewer");
  const [mapScopes, setMapScopes] = useState<Scope[]>([]);
  const [mapError,  setMapError]  = useState("");

  const load = () => {
    fetch("/api/users").then(r => r.json()).then(data => {
      setUsers(data);
      // Keep edit panel in sync if editing
      if (editingUser) {
        const updated = data.find((u: User) => u.id === editingUser.id);
        if (updated) setEditingUser(updated);
      }
    });
    fetch("/api/group-mappings").then(r => r.json()).then(setMappings);
    fetch("/api/org").then(r => r.json()).then(setOrg);
  };

  useEffect(() => { load(); }, []);

  const addUser = async () => {
    if (!newName || !newEmail || !newPassword || !newRole) {
      setAddError("Name, email, password and role are required");
      return;
    }
    setAddError("");
    const res = await fetch("/api/users", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ displayName: newName, email: newEmail, password: newPassword, role: newRole, scopes: newScopes }),
    });
    const data = await res.json();
    if (!res.ok) { setAddError(data.error ?? "Failed to add user"); return; }
    setNewName(""); setNewEmail(""); setNewPassword(""); setNewRole("viewer"); setNewScopes([]);
    setSuccess("User added"); setTimeout(() => setSuccess(""), 3000);
    load();
  };

  const deleteUser = async (id: number) => {
    await fetch(`/api/users/${id}`, { method: "DELETE" });
    if (editingUser?.id === id) setEditingUser(null);
    load();
  };

  const addMapping = async () => {
    if (!mapGroup || !mapRole) { setMapError("Group name and role are required"); return; }
    setMapError("");
    const res = await fetch("/api/group-mappings", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ groupName: mapGroup, role: mapRole, scopes: mapScopes }),
    });
    const data = await res.json();
    if (!res.ok) { setMapError(data.error ?? "Failed to add mapping"); return; }
    setMapGroup(""); setMapRole("viewer"); setMapScopes([]);
    load();
  };

  const deleteMapping = async (id: number) => {
    await fetch(`/api/group-mappings/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="app">
      <div className="um-page-title">User management</div>
      <div className="um-page-sub">Manage local users and map AD / Entra groups to roles and scopes.</div>

      {success && <div className="um-success">{success}</div>}

      <div className="um-layout">
        <div className="um-left">

          {/* ── Users table ── */}
          <div className="um-section-title">Local &amp; provisioned users</div>
          <div className="table-wrap">
            <table className="um-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Auth</th>
                  <th>Scopes</th>
                  <th>Last login</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={editingUser?.id === u.id ? { background: "#1a2535" } : undefined}>
                    <td><div className="um-name">{u.displayName}</div><div className="um-email">{u.email}</div></td>
                    <td><RoleBadge role={u.role} /></td>
                    <td><AuthBadge source={u.authSource} /></td>
                    <td><ScopeTags scopes={u.scopes} /></td>
                    <td className="um-scope">{relativeTime(u.lastLogin)}</td>
                    <td style={{ minWidth: 180 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <button
                          className={`um-edit-btn ${editingUser?.id === u.id ? "um-edit-btn-active" : ""}`}
                          onClick={() => setEditingUser(editingUser?.id === u.id ? null : u)}>
                          {editingUser?.id === u.id ? "Editing…" : "Edit"}
                        </button>
                        {u.id !== currentUserId && (
                          <InlineConfirm
                            label="Remove"
                            confirmLabel="Remove user?"
                            onConfirm={() => deleteUser(u.id)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={6} className="um-empty">No users found</td></tr>}
              </tbody>
            </table>
          </div>

          {/* ── Group mappings table ── */}
          <div className="um-section-title" style={{ marginTop: 24 }}>AD / Entra group mappings</div>
          <div className="table-wrap">
            <div className="table-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Group → role mappings</span>
              <span style={{ fontSize: 11, color: "#555870", fontWeight: 400 }}>applied on every LDAP / Entra login</span>
            </div>
            <table className="um-table">
              <thead>
                <tr>
                  <th style={{ width: "30%" }}>AD / Entra group name</th>
                  <th style={{ width: "12%" }}>Role</th>
                  <th>Scopes</th>
                  <th style={{ width: "160px" }}></th>
                </tr>
              </thead>
              <tbody>
                {mappings.map(m => (
                  <tr key={m.id}>
                    <td><span className="um-groupname">{m.groupName}</span></td>
                    <td><RoleBadge role={m.role} /></td>
                    <td><ScopeTags scopes={m.scopes} /></td>
                    <td>
                      <InlineConfirm
                        label="Remove"
                        confirmLabel="Remove mapping?"
                        onConfirm={() => deleteMapping(m.id)}
                      />
                    </td>
                  </tr>
                ))}
                <tr className="um-add-row">
                  <td>
                    <input className="um-inline-input" placeholder="Nomyx-DOA-Finance-Op"
                      value={mapGroup} onChange={e => setMapGroup(e.target.value)} />
                  </td>
                  <td>
                    <select className="um-inline-select" value={mapRole} onChange={e => setMapRole(e.target.value)}>
                      <option value="viewer">viewer</option>
                      <option value="operator">operator</option>
                      <option value="noc">noc</option>
                      <option value="admin">admin</option>
                      <option value="global_admin">global admin</option>
                    </select>
                  </td>
                  <td>
                    <ScopeBuilder scopes={mapScopes} org={org} onChange={setMapScopes} />
                  </td>
                  <td>
                    <button className="um-add-mapping-btn" onClick={addMapping}>Add mapping</button>
                  </td>
                </tr>
                {mapError && (
                  <tr><td colSpan={4} className="um-error" style={{ padding: "6px 12px" }}>{mapError}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Right panel: edit or add ── */}
        {editingUser ? (
          <EditUserPanel
            user={editingUser}
            org={org}
            onSave={() => {
              setSuccess("User updated"); setTimeout(() => setSuccess(""), 3000);
              setEditingUser(null);
              load();
            }}
            onCancel={() => setEditingUser(null)}
          />
        ) : (
          <div className="um-form">
            <div className="um-form-title">Add local user</div>
            <div className="um-field">
              <label className="um-label">Display name</label>
              <input className="um-input" type="text" placeholder="Jane Smith"
                value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <div className="um-field">
              <label className="um-label">Email</label>
              <input className="um-input" type="email" placeholder="jane@nomyx.local"
                value={newEmail} onChange={e => setNewEmail(e.target.value)} />
            </div>
            <div className="um-field">
              <label className="um-label">Password</label>
              <input className="um-input" type="password" placeholder="••••••••"
                value={newPassword} onChange={e => setNewPassword(e.target.value)} />
            </div>
            <div className="um-field">
              <label className="um-label">Role</label>
              <select className="um-input" value={newRole} onChange={e => setNewRole(e.target.value)}>
                <option value="viewer">viewer</option>
                <option value="operator">operator</option>
                <option value="noc">noc</option>
                <option value="admin">admin</option>
                <option value="global_admin">global admin</option>
              </select>
            </div>
            <div className="um-field">
              <label className="um-label">Scopes <span className="um-optional">(optional)</span></label>
              <ScopeBuilder scopes={newScopes} org={org} onChange={setNewScopes} />
            </div>
            {addError && <div className="um-error">{addError}</div>}
            <button className="um-submit-btn" onClick={() => void addUser()}>Create user</button>
            <div className="um-note">
              LDAP and Entra users are provisioned automatically on first login. Their role and scopes come from the group mappings table.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}