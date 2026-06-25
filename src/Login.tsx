import { useState } from "react";

interface Props {
  onLogin: (user: any) => void;
}

type AuthMode = "local" | "ldap";

export default function Login({ onLogin }: Props) {
  const [mode,     setMode]     = useState<AuthMode>("local");
  const [username, setUsername] = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

  const submitLocal = async () => {
    if (!email || !password) { setError("Email and password are required"); return; }
    setLoading(true);
    setError("");
    const res  = await fetch("/api/auth/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password })
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) { setError(data.error ?? "Login failed"); return; }
    onLogin(data.user);
  };

  const submitLdap = async () => {
    if (!username || !password) { setError("Username and password are required"); return; }
    setLoading(true);
    setError("");
    const res  = await fetch("/api/auth/ldap", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ username, password })
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) { setError(data.error ?? "Login failed"); return; }
    onLogin(data.user);
  };

  const submit = mode === "ldap" ? submitLdap : submitLocal;

  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-logo">
          <span className="header-dot" />
          <span className="login-title">Nomyx</span>
        </div>
        <div className="login-sub">Infrastructure monitoring</div>

        {/* Microsoft SSO */}
        <button className="entra-btn" onClick={async () => {
          const res  = await fetch("/api/auth/entra");
          const data = await res.json();
          window.location.href = data.url;
        }}>
          <svg width="16" height="16" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: 8 }}>
            <rect x="1"  y="1"  width="9" height="9" fill="#f25022"/>
            <rect x="11" y="1"  width="9" height="9" fill="#7fba00"/>
            <rect x="1"  y="11" width="9" height="9" fill="#00a4ef"/>
            <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
          </svg>
          Sign in with Microsoft
        </button>

        <div className="login-divider"><span>or</span></div>

        {/* Local / LDAP toggle */}
        <div className="login-mode-toggle">
          <button
            className={`login-mode-btn ${mode === "local" ? "active" : ""}`}
            onClick={() => { setMode("local"); setError(""); }}>
            Local
          </button>
          <button
            className={`login-mode-btn ${mode === "ldap" ? "active" : ""}`}
            onClick={() => { setMode("ldap"); setError(""); }}>
            AD / LDAP
          </button>
        </div>

        {/* Username field (LDAP) or Email field (local) */}
        {mode === "ldap" ? (
          <div className="login-field">
            <label className="login-label">Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={e => e.key === "Enter" && void submit()}
              placeholder="jsmith or jsmith@nomyx.local"
              className="login-input"
              autoFocus
            />
          </div>
        ) : (
          <div className="login-field">
            <label className="login-label">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && void submit()}
              placeholder="admin@nomyx.local"
              className="login-input"
              autoFocus
            />
          </div>
        )}

        <div className="login-field">
          <label className="login-label">Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && void submit()}
            placeholder="••••••••"
            className="login-input"
          />
        </div>

        {error && <div className="login-error">{error}</div>}

        <button
          className="login-btn"
          onClick={() => void submit()}
          disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </div>
  );
}