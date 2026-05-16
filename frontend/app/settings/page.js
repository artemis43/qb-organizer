"use client";
import { useState, useEffect } from "react";
import { getSettings, updateSettings, fullReset, deleteAllMappings } from "../../lib/api";

export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [openSections, setOpenSections] = useState({ api: true, matching: false, processing: false, cost: true, danger: false });
  const [form, setForm] = useState({});

  useEffect(() => { loadSettings(); }, []);

  async function loadSettings() {
    try {
      const s = await getSettings();
      setSettings(s);
      setForm({
        api_key: s.api_key_masked,
        haiku_model: s.haiku_model,
        sonnet_model: s.sonnet_model,
        budget_limit: s.budget_limit,
        confidence_high: s.confidence_high,
        confidence_low: s.confidence_low,
        chunk_size: s.chunk_size,
        chunk_overlap: s.chunk_overlap,
        embedding_model: s.embedding_model,
      });
    } catch (e) {
      showToast("Failed to load settings", "error");
    }
    setLoading(false);
  }

  function showToast(msg, type = "info") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  function toggleSection(key) {
    setOpenSections(s => ({ ...s, [key]: !s[key] }));
  }

  function updateField(key, val) {
    setForm(f => ({ ...f, [key]: val }));
  }

  async function saveSettings() {
    setSaving(true);
    try {
      const res = await updateSettings(form);
      showToast(`Saved: ${res.changed?.join(", ") || "no changes"}`, "success");
      await loadSettings();
    } catch (e) {
      showToast("Save failed: " + e.message, "error");
    }
    setSaving(false);
  }

  async function handleReset(type) {
    const msg = type === "full"
      ? "This will DELETE ALL data (textbooks, papers, mappings, embeddings). Are you sure?"
      : "This will delete all question-chapter mappings. Are you sure?";
    if (!confirm(msg)) return;
    if (type === "full" && !confirm("FINAL WARNING: This cannot be undone. Proceed?")) return;
    try {
      if (type === "full") await fullReset();
      else await deleteAllMappings();
      showToast(type === "full" ? "All data reset" : "Mappings cleared", "success");
    } catch (e) {
      showToast("Reset failed: " + e.message, "error");
    }
  }

  if (loading) return <div className="loading-overlay"><div className="spinner"></div> Loading settings...</div>;

  const cost = settings?.cost || {};
  const budgetPct = cost.budget_limit ? ((cost.total_spent / cost.budget_limit) * 100).toFixed(1) : 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">⚙️ Settings</h1>
          <p className="page-subtitle">Configure matching engine, API, and processing parameters</p>
        </div>
        <button className="btn btn-primary" onClick={saveSettings} disabled={saving}>
          {saving ? "Saving..." : "💾 Save Changes"}
        </button>
      </div>

      {/* API Configuration */}
      <Section title="🔑 API Configuration" sKey="api" open={openSections.api} toggle={toggleSection}>
        <SettingsField label="Anthropic API Key" hint="Your Claude API key. Only updated if a full key is provided.">
          <input className="input" type="password" value={form.api_key || ""} onChange={e => updateField("api_key", e.target.value)} placeholder="sk-ant-..." />
        </SettingsField>
        <SettingsField label="Haiku Model" hint="Fast model for extraction and classification">
          <input className="input" value={form.haiku_model || ""} onChange={e => updateField("haiku_model", e.target.value)} />
        </SettingsField>
        <SettingsField label="Sonnet Model" hint="Powerful model for complex tasks">
          <input className="input" value={form.sonnet_model || ""} onChange={e => updateField("sonnet_model", e.target.value)} />
        </SettingsField>
        <SettingsField label="Budget Limit ($)" hint="Maximum API spend allowed">
          <input className="input" type="number" step="1" value={form.budget_limit || ""} onChange={e => updateField("budget_limit", e.target.value)} />
        </SettingsField>
        <div style={{ marginTop: 10, padding: "8px 12px", background: "var(--surface)", borderRadius: 7, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Status:</span>
          <span style={{ fontSize: 12, fontFamily: "var(--mono)", color: settings?.api_key_set ? "var(--success)" : "var(--danger)" }}>
            {settings?.api_key_set ? "✓ API key configured" : "✗ API key not set"}
          </span>
        </div>
      </Section>

      {/* Matching Tuning */}
      <Section title="🎯 Matching Engine" sKey="matching" open={openSections.matching} toggle={toggleSection}>
        <SettingsField label="HIGH Confidence Threshold" hint="Score ≥ this → auto-accepted (no manual review needed)">
          <input className="input" type="number" step="0.05" min="0" max="1" value={form.confidence_high || ""} onChange={e => updateField("confidence_high", e.target.value)} />
        </SettingsField>
        <SettingsField label="LOW Confidence Threshold" hint="Score < this → marked as LOW (needs careful review)">
          <input className="input" type="number" step="0.05" min="0" max="1" value={form.confidence_low || ""} onChange={e => updateField("confidence_low", e.target.value)} />
        </SettingsField>
        <SettingsField label="Embedding Model" hint="PubMedBERT recommended for medical text">
          <input className="input" value={form.embedding_model || ""} onChange={e => updateField("embedding_model", e.target.value)} />
        </SettingsField>
      </Section>

      {/* Processing */}
      <Section title="📦 Processing" sKey="processing" open={openSections.processing} toggle={toggleSection}>
        <SettingsField label="Chunk Size" hint="Characters per text chunk for embedding">
          <input className="input" type="number" step="50" value={form.chunk_size || ""} onChange={e => updateField("chunk_size", e.target.value)} />
        </SettingsField>
        <SettingsField label="Chunk Overlap" hint="Overlap between consecutive chunks">
          <input className="input" type="number" step="25" value={form.chunk_overlap || ""} onChange={e => updateField("chunk_overlap", e.target.value)} />
        </SettingsField>
      </Section>

      {/* Cost Dashboard */}
      <Section title="💰 Cost Dashboard" sKey="cost" open={openSections.cost} toggle={toggleSection}>
        <div className="grid-3" style={{ marginBottom: 16 }}>
          <div className="stat-card">
            <div className="stat-value" style={{ color: "var(--success)" }}>${cost.total_spent?.toFixed(4) || "0.00"}</div>
            <div className="stat-label">Total Spent</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">${cost.budget_remaining?.toFixed(2) || "25.00"}</div>
            <div className="stat-label">Budget Remaining</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{cost.api_calls_made || 0}</div>
            <div className="stat-label">API Calls Made</div>
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div className="progress-bar-container">
            <div className="progress-bar-fill" style={{ width: `${Math.min(budgetPct, 100)}%`, background: budgetPct > 80 ? "var(--danger)" : undefined }}></div>
          </div>
          <div className="progress-text">
            <span>Budget used</span>
            <span>{budgetPct}%</span>
          </div>
        </div>
        {cost.breakdown && Object.keys(cost.breakdown).length > 0 && (
          <div>
            <div className="input-label" style={{ marginBottom: 8 }}>Cost Breakdown</div>
            <div className="table-container">
              <table>
                <thead><tr><th>Task Type</th><th style={{ textAlign: "right" }}>Cost</th></tr></thead>
                <tbody>
                  {Object.entries(cost.breakdown).map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>${v.toFixed(4)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      {/* Danger Zone */}
      <Section title="⚠️ Danger Zone" sKey="danger" open={openSections.danger} toggle={toggleSection}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button className="btn" style={{ background: "var(--warning-bg)", color: "var(--warning)", borderColor: "rgba(251,191,36,0.3)" }} onClick={() => handleReset("mappings")}>
            🗑 Clear All Mappings
          </button>
          <button className="btn" style={{ background: "var(--danger-bg)", color: "var(--danger)", borderColor: "rgba(248,113,113,0.3)" }} onClick={() => handleReset("full")}>
            💣 Full Reset — Delete Everything
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 10 }}>
          Full reset deletes all textbooks, question papers, mappings, embeddings, and uploaded files. This cannot be undone.
        </p>
      </Section>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

function Section({ title, sKey, open, toggle, children }) {
  return (
    <div className="settings-section animate-in" style={{ animationDelay: `${["api","matching","processing","cost","danger"].indexOf(sKey) * 0.04}s` }}>
      <div className={`settings-section-header ${open ? "open" : ""}`} onClick={() => toggle(sKey)}>
        <div className="settings-section-title">{title}</div>
        <span style={{ fontSize: 12, color: "var(--text-dim)", transition: "transform var(--t)", transform: open ? "rotate(180deg)" : "rotate(0)" }}>▼</span>
      </div>
      {open && <div className="settings-section-body">{children}</div>}
    </div>
  );
}

function SettingsField({ label, hint, children }) {
  return (
    <div className="settings-field">
      <div className="settings-field-label">
        {label}
        {hint && <div className="settings-field-hint">{hint}</div>}
      </div>
      <div className="settings-field-input">{children}</div>
    </div>
  );
}
