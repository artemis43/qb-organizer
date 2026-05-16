"use client";
import { useState, useEffect } from "react";
import { getDashboard } from "@/lib/api";

export default function DashboardPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadDashboard();
  }, []);

  async function loadDashboard() {
    try {
      setLoading(true);
      const d = await getDashboard();
      setData(d);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="loading-overlay">
        <div className="spinner" />
        <span>Loading dashboard...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⚠️</div>
        <div className="empty-state-title">Backend not connected</div>
        <div className="empty-state-text">
          Make sure the Python backend is running on port 8000.
          <br />
          <code style={{ fontSize: 13, color: "var(--accent)", marginTop: 8, display: "block", fontFamily: "var(--mono)" }}>
            cd qb-organizer/backend && python server.py
          </code>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={loadDashboard}>
          Retry
        </button>
      </div>
    );
  }

  const stats = data || {};
  const cost = stats.cost || {};
  const conf = stats.confidence_distribution || {};

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Overview of your knowledge base and processing pipeline</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={loadDashboard}>
          ↻ Refresh
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid-4" style={{ marginBottom: 28 }}>
        <StatCard icon="📚" value={stats.total_textbooks || 0} label="Textbooks" />
        <StatCard icon="📑" value={stats.total_chapters || 0} label="Chapters Indexed" />
        <StatCard icon="📄" value={stats.total_qps || 0} label="Question Papers" />
        <StatCard icon="❓" value={stats.total_questions || 0} label="Questions Extracted" />
      </div>

      <div className="grid-3" style={{ marginBottom: 28 }}>
        {/* Confidence Distribution */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Confidence Distribution</span>
          </div>
          <ConfidenceBar high={conf.high || 0} medium={conf.medium || 0} low={conf.low || 0} />
          <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
            <ConfidenceStat label="High" value={conf.high || 0} color="var(--success)" />
            <ConfidenceStat label="Medium" value={conf.medium || 0} color="var(--warning)" />
            <ConfidenceStat label="Low" value={conf.low || 0} color="var(--danger)" />
          </div>
        </div>

        {/* API Cost */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">💰 API Usage</span>
          </div>
          <div className="card-value">${(cost.total_spent || 0).toFixed(2)}</div>
          <div className="card-label">of ${(cost.budget_limit || 25).toFixed(2)} budget</div>
          <div style={{ marginTop: 12 }}>
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{
                  width: `${Math.min(((cost.total_spent || 0) / (cost.budget_limit || 25)) * 100, 100)}%`,
                  background: (cost.total_spent || 0) > (cost.budget_limit || 25) * 0.8
                    ? "var(--danger)" : undefined,
                }}
              />
            </div>
          </div>
          <div className="card-label" style={{ marginTop: 8 }}>
            {cost.api_calls_made || 0} API calls made
          </div>
        </div>

        {/* Matching Progress */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🔗 Matching</span>
          </div>
          <div className="card-value">{stats.total_matched || 0}</div>
          <div className="card-label">questions matched to chapters</div>
          {stats.total_questions > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="progress-bar-container">
                <div
                  className="progress-bar-fill"
                  style={{
                    width: `${((stats.total_matched || 0) / stats.total_questions) * 100}%`,
                  }}
                />
              </div>
              <div className="progress-text">
                <span>{stats.total_matched || 0} / {stats.total_questions}</span>
                <span>{((stats.total_matched || 0) / stats.total_questions * 100).toFixed(0)}%</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Subjects & Activity */}
      <div className="grid-2">
        {/* Subjects */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">📚 Subjects</span>
          </div>
          {(stats.subjects || []).length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "16px 0" }}>
              No subjects yet. Upload a textbook to get started.
            </div>
          ) : (
            <div>
              {stats.subjects.map((s, i) => (
                <div key={i} className="activity-item">
                  <span className={`status-dot ${s.status || "pending"}`} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                      {s.textbooks || 0} textbooks · {s.chapters || 0} chapters · {s.qps || 0} QPs
                    </div>
                  </div>
                  <span className={`badge badge-${s.status === "completed" ? "high" : s.status === "in_progress" ? "medium" : "info"}`}>
                    {s.status || "pending"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🕐 Recent Activity</span>
          </div>
          {(stats.recent_activity || []).length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "16px 0" }}>
              No activity yet.
            </div>
          ) : (
            <div>
              {stats.recent_activity.slice(0, 8).map((a, i) => (
                <div key={i} className="activity-item">
                  <span style={{ fontSize: 16 }}>
                    {a.level === "error" ? "🔴" : a.level === "warning" ? "🟡" : "🟢"}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: "var(--text)" }}>{a.message}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      {a.task} · {a.timestamp ? new Date(a.timestamp).toLocaleString() : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, value, label }) {
  return (
    <div className="stat-card">
      <div className="stat-icon">{icon}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function ConfidenceBar({ high, medium, low }) {
  const total = high + medium + low || 1;
  return (
    <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--surface)" }}>
      {high > 0 && (
        <div style={{ width: `${(high / total) * 100}%`, background: "var(--success)", transition: "width 0.5s" }} />
      )}
      {medium > 0 && (
        <div style={{ width: `${(medium / total) * 100}%`, background: "var(--warning)", transition: "width 0.5s" }} />
      )}
      {low > 0 && (
        <div style={{ width: `${(low / total) * 100}%`, background: "var(--danger)", transition: "width 0.5s" }} />
      )}
    </div>
  );
}

function ConfidenceStat({ label, value, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
      <span style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>{label}: {value}</span>
    </div>
  );
}
