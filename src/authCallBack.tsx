import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Props {
  onLogin: (user: any) => void;
}

export default function AuthCallback({ onLogin }: Props) {
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get("code");
    const err    = params.get("error");

    if (err) {
      setError(params.get("error_description") ?? "Authentication failed");
      return;
    }

    if (!code) {
      setError("No authorization code received");
      return;
    }

    fetch("/api/auth/entra/callback", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ code })
    })
      .then(res => res.json())
      .then(data => {
        if (data.ok) {
          onLogin(data.user);
          navigate("/");
        } else {
          setError(data.error ?? "Authentication failed");
        }
      })
      .catch(() => setError("Network error during authentication"));
  }, []);

  if (error) return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-logo">
          <span className="header-dot" />
          <span className="login-title">Nomyx</span>
        </div>
        <div className="login-error" style={{ marginTop: 16 }}>{error}</div>
        <button className="login-btn" style={{ marginTop: 16 }} onClick={() => navigate("/")}>
          Back to login
        </button>
      </div>
    </div>
  );

  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-logo">
          <span className="header-dot" />
          <span className="login-title">Nomyx</span>
        </div>
        <div className="login-sub" style={{ marginTop: 16 }}>Completing sign in…</div>
      </div>
    </div>
  );
}