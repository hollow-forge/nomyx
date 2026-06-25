import { useState } from "react";

interface Props {
  user: any;
  onClose: () => void;
}

export default function Account({ user, onClose }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword,     setNewPassword]     = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error,           setError]           = useState("");
  const [success,         setSuccess]         = useState("");
  const [loading,         setLoading]         = useState(false);

  const changePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setError("All fields are required");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    const res = await fetch("/api/auth/change-password", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ currentPassword, newPassword })
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Failed to change password");
      return;
    }

    setSuccess("Password changed successfully");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  return (
    <div className="account-overlay" onClick={onClose}>
      <div className="account-panel" onClick={e => e.stopPropagation()}>
        <div className="account-header">
          <div className="account-name">{user.displayName}</div>
          <div className="account-email">{user.email}</div>
          <div className="account-role">{user.role}</div>
        </div>

        <div className="account-section-label">Change password</div>

        <div className="account-field">
          <label className="login-label">Current password</label>
          <input type="password" value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            className="login-input" />
        </div>
        <div className="account-field">
          <label className="login-label">New password</label>
          <input type="password" value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            className="login-input" />
        </div>
        <div className="account-field">
          <label className="login-label">Confirm new password</label>
          <input type="password" value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && void changePassword()}
            className="login-input" />
        </div>

        {error   && <div className="login-error">{error}</div>}
        {success && <div className="account-success">{success}</div>}

        <button className="login-btn" onClick={() => void changePassword()} disabled={loading}>
          {loading ? "Changing…" : "Change password"}
        </button>

        <button className="account-close-btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}