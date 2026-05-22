"use client";
import { useState, useEffect } from "react";
import { getSettings, updateSettings, getSystemInfo, fullReset, deleteAllMappings } from "../../lib/api";

export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [sysInfo, setSysInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [openSections, setOpenSections] = useState({
    api: true,
    matching: false,
    processing: false,
    answerGen: false,
    kg: false,
    exportDeploy: false,
    sysinfo: true,
    cost: false,
    danger: false
  });
  const [form, setForm] = useState({});

  useEffect(() => { loadSettings(); }, []);

  async function loadSettings() {
    try {
      const [s, sys] = await Promise.all([getSettings(), getSystemInfo()]);
      setSettings(s);
      setSysInfo(sys);
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
        
        default_answer_mode: s.default_answer_mode || "auto",
        default_answer_preset: s.default_answer_preset || "SAQ",
        answer_temperature: s.answer_temperature ?? 0.3,
        kg_extraction_model: s.kg_extraction_model || "haiku",
        kg_max_concepts_per_batch: s.kg_max_concepts_per_batch ?? 50,
        kg_enable_relation_extraction: s.kg_enable_relation_extraction ?? true,
        kg_default_limit: s.kg_default_limit ?? 150,
        fs_collection_prefix: s.fs_collection_prefix || "",
        imagekit_folder: s.imagekit_folder || "/qb-organizer",
      });
    } catch (e) {
      showToast("Failed to load settings: " + e.message, "error");
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
      await loadSettings();
    } catch (e) {
      showToast("Reset failed: " + e.message, "error");
    }
  }

  if (loading) return <div className="loading-overlay"><div className="spinner"></div> Loading settings...</div>;

  const cost = settings?.cost || {};
  const budgetPct = cost.budget_limit ? ((cost.total_spent / cost.budget_limit) * 100).toFixed(1) : 0;
  const disk = sysInfo?.disk_usage || { total_gb: 0, used_gb: 0, free_gb: 0, pct_used: 0 };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">⚙️ Settings</h1>
          <p className="page-subtitle">Configure matching engine, API, processing, answers, and visual settings</p>
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

      {/* Answer Generation */}
      <Section title="🤖 Answer Generation" sKey="answerGen" open={openSections.answerGen} toggle={toggleSection}>
        <SettingsField label="Default Answer Mode" hint="Default retrieval strategy to run">
          <select className="select" value={form.default_answer_mode} onChange={e => updateField("default_answer_mode", e.target.value)}>
            <option value="auto">Auto (Merged context)</option>
            <option value="graph_only">GraphRAG Only (Pure Concept relationships)</option>
            <option value="hybrid">Hybrid Fusion (Dual path merged answers)</option>
          </select>
        </SettingsField>
        <SettingsField label="Default Answer Preset" hint="Target template format and length constraints">
          <select className="select" value={form.default_answer_preset} onChange={e => updateField("default_answer_preset", e.target.value)}>
            <option value="LAQ">LAQ (Long Answer, 15-20 bullets)</option>
            <option value="SAQ">SAQ (Short Answer, 8-12 bullets)</option>
            <option value="VSAQ">VSAQ (Very Short Answer, 7-8 bullets)</option>
          </select>
        </SettingsField>
        <SettingsField label="Answer Temperature" hint="Generation creativity/randomness (0.0 = deterministic)">
          <input className="input" type="number" step="0.1" min="0" max="1.2" value={form.answer_temperature} onChange={e => updateField("answer_temperature", parseFloat(e.target.value) || 0.3)} />
        </SettingsField>
      </Section>

      {/* Knowledge Graph */}
      <Section title="🕸️ Knowledge Graph" sKey="kg" open={openSections.kg} toggle={toggleSection}>
        <SettingsField label="KG Extraction Model" hint="AI model to build the concept maps (e.g. haiku, sonnet)">
          <input className="input" value={form.kg_extraction_model} onChange={e => updateField("kg_extraction_model", e.target.value)} />
        </SettingsField>
        <SettingsField label="Max Concepts per Batch" hint="Chunk sizes when building concepts">
          <input className="input" type="number" step="5" min="5" value={form.kg_max_concepts_per_batch} onChange={e => updateField("kg_max_concepts_per_batch", parseInt(e.target.value) || 50)} />
        </SettingsField>
        <SettingsField label="Relation Extraction" hint="Extract chains of relationships between medical concepts">
          <select className="select" value={String(form.kg_enable_relation_extraction)} onChange={e => updateField("kg_enable_relation_extraction", e.target.value === "true")}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>
        <SettingsField label="Default Concept Limit" hint="Default number of concepts to render in visual graph view">
          <input className="input" type="number" step="50" min="50" max="2000" value={form.kg_default_limit} onChange={e => updateField("kg_default_limit", parseInt(e.target.value) || 150)} />
        </SettingsField>
      </Section>

      {/* Export & Deployment */}
      <Section title="🚀 Export & Deployment" sKey="exportDeploy" open={openSections.exportDeploy} toggle={toggleSection}>
        <SettingsField label="Firestore Collection Prefix" hint="Prefix for your Firestore collections (e.g. dev_)">
          <input className="input" value={form.fs_collection_prefix} onChange={e => updateField("fs_collection_prefix", e.target.value)} placeholder="e.g. dev_" />
        </SettingsField>
        <SettingsField label="ImageKit Folder Path" hint="Target folder path for uploaded diagrams in ImageKit">
          <input className="input" value={form.imagekit_folder} onChange={e => updateField("imagekit_folder", e.target.value)} placeholder="/qb-organizer" />
        </SettingsField>
      </Section>

      {/* System Info & Metrics */}
      <Section title="🖥️ System Info & Metrics" sKey="sysinfo" open={openSections.sysinfo} toggle={toggleSection}>
        {sysInfo ? (
          <div>
            <div className="grid-4" style={{ marginBottom: 20 }}>
              <div className="stat-card">
                <div className="stat-value" style={{ fontSize: 20, color: "var(--accent)" }}>{sysInfo.python_version}</div>
                <div className="stat-label">Python Version</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ fontSize: 20 }}>{sysInfo.database_size_mb} MB</div>
                <div className="stat-label">SQLite File Size</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ fontSize: 20, color: "var(--success)" }}>{sysInfo.vector_chunks}</div>
                <div className="stat-label">Vector Chunks</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ fontSize: 20 }}>{disk.free_gb} GB</div>
                <div className="stat-label">Disk Storage Free</div>
              </div>
            </div>

            {/* Storage Progress Bar */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4, fontWeight: 600, color: "var(--text-dim)" }}>
                <span>DISK SPACE USAGE</span>
                <span>{disk.used_gb} GB / {disk.total_gb} GB ({disk.pct_used}%)</span>
              </div>
              <div className="progress-bar-container">
                <div className="progress-bar-fill" style={{ width: `${disk.pct_used}%`, background: disk.pct_used > 85 ? "var(--danger)" : "var(--accent)" }} />
              </div>
            </div>

            {/* Packages */}
            <div className="input-label" style={{ marginBottom: 8 }}>Installed Python Packages</div>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Package Name</th>
                    <th>Installed Version</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(sysInfo.package_versions || {}).map(([name, ver]) => (
                    <tr key={name}>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{name}</td>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 12, color: ver === "not installed" ? "var(--danger)" : "var(--text-bright)" }}>
                        {ver}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div style={{ padding: 12, textAlign: "center", fontStyle: "italic", color: "var(--text-dim)" }}>
            Unable to load system info specifications.
          </div>
        )}
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
    <div className="settings-section animate-in" style={{ animationDelay: `${["api","matching","processing","answerGen","kg","exportDeploy","sysinfo","cost","danger"].indexOf(sKey) * 0.04}s` }}>
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
