"use client";
import { useState, useEffect } from "react";
import { getDashboard } from "@/lib/api";

export default function DashboardPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedSubject, setExpandedSubject] = useState(null);

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
  const kg = stats.kg_stats || { concepts: 0, relations: 0, must_know: 0 };
  const answers = stats.answer_stats || { total: 0, pct_answered: 0, avg_bullets: 0, modes: { auto: 0, graph_only: 0, hybrid: 0 } };
  const review = stats.review_progress || { total: 0, reviewed: 0, pending: 0, auto_accepted: 0, manually_reviewed: 0 };
  const subDetails = stats.subject_details || {};

  // Pipeline Health Calculation
  const pipelineSteps = [
    { name: "Upload", status: stats.total_textbooks > 0 ? "completed" : "pending", desc: "Textbooks indexed" },
    { name: "Extract", status: stats.total_chapters > 0 ? "completed" : "pending", desc: "Chapters indexed" },
    { name: "Match", status: stats.total_questions > 0 ? (stats.total_matched > 0 ? "completed" : "in-progress") : "pending", desc: "Questions matched" },
    { name: "Review", status: review.total > 0 ? (review.pending === 0 ? "completed" : "in-progress") : "pending", desc: `${review.reviewed}/${review.total} approved` },
    { name: "Answer", status: answers.total > 0 ? (answers.pct_answered > 80 ? "completed" : "in-progress") : "pending", desc: `${answers.pct_answered}% generated` },
    { name: "Deploy", status: answers.total > 0 && review.pending === 0 ? "completed" : "pending", desc: "Ready for Firebase" }
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">📊 QB-Organizer Dashboard</h1>
          <p className="page-subtitle">Unified metrics, data insights, and pipeline status</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={loadDashboard}>
          ↻ Refresh
        </button>
      </div>

      {/* Pipeline Health Tracker */}
      <div className="card" style={{ marginBottom: 28 }}>
        <div className="card-header" style={{ marginBottom: 16 }}>
          <span className="card-title">⚙️ Pipeline Health Indicator</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative", padding: "0 10px" }}>
          {/* Connector Line */}
          <div style={{
            position: "absolute",
            top: 20,
            left: 50,
            right: 50,
            height: 4,
            background: "var(--border)",
            zIndex: 1
          }} />

          {pipelineSteps.map((step, idx) => {
            let color = "var(--text-dim)";
            let bg = "var(--surface)";
            let shadow = "none";
            if (step.status === "completed") {
              color = "var(--success)";
              bg = "rgba(16, 185, 129, 0.25)";
              shadow = "0 0 10px var(--success)";
            } else if (step.status === "in-progress") {
              color = "var(--warning)";
              bg = "rgba(245, 158, 11, 0.25)";
              shadow = "0 0 10px var(--warning)";
            }
            
            return (
              <div key={idx} style={{ zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", width: 100 }}>
                <div style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: bg,
                  border: `2px solid ${color}`,
                  boxShadow: shadow,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: "bold",
                  fontSize: 16,
                  color: color,
                  marginBottom: 8,
                  transition: "all 0.3s ease"
                }}>
                  {step.status === "completed" ? "✓" : idx + 1}
                </div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-bright)" }}>{step.name}</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", textAlign: "center", marginTop: 2 }}>{step.desc}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main stats counters */}
      <div className="grid-4" style={{ marginBottom: 28 }}>
        <StatCard icon="📚" value={stats.total_textbooks || 0} label="Textbooks" />
        <StatCard icon="📑" value={stats.total_chapters || 0} label="Chapters Indexed" />
        <StatCard icon="📄" value={stats.total_qps || 0} label="Question Papers" />
        <StatCard icon="❓" value={stats.total_questions || 0} label="Questions Extracted" />
      </div>

      {/* Enriched Stats Grid */}
      <div className="grid-3" style={{ marginBottom: 28 }}>
        {/* Knowledge Graph Card */}
        <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div className="card-header" style={{ marginBottom: 12 }}>
              <span className="card-title">🕸️ Knowledge Graph</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
                <span style={{ color: "var(--text-dim)", fontSize: 13 }}>Total Concepts:</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-bright)" }}>{kg.concepts}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
                <span style={{ color: "var(--text-dim)", fontSize: 13 }}>Relationships:</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-bright)" }}>{kg.relations}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", paddingBottom: 6 }}>
                <span style={{ color: "var(--text-dim)", fontSize: 13 }}>Must-Know Terms:</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: "var(--success)" }}>{kg.must_know}</span>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            Used for Graph RAG Answer generation context.
          </div>
        </div>

        {/* Answer Generation Card */}
        <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div className="card-header" style={{ marginBottom: 12 }}>
              <span className="card-title">🤖 Answer Engine</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <div className="card-value" style={{ margin: 0, fontSize: 32 }}>{answers.total}</div>
              <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
                {answers.pct_answered}% of questions answered
              </div>
            </div>
            <div className="progress-bar-container" style={{ marginBottom: 14 }}>
              <div className="progress-bar-fill" style={{ width: `${answers.pct_answered}%` }} />
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Avg Bullets</div>
                <div style={{ fontWeight: 600, fontSize: 15, color: "var(--text-bright)" }}>{answers.avg_bullets}</div>
              </div>
              <div style={{ flex: 2 }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Retrieval Modes</div>
                <div style={{ display: "flex", gap: 6, fontSize: 10, marginTop: 2 }}>
                  <span className="badge badge-info" title="Graph RAG only">G: {answers.modes?.graph_only || 0}</span>
                  <span className="badge badge-high" title="Dual / Hybrid">H: {answers.modes?.hybrid || 0}</span>
                  <span className="badge badge-medium" title="Auto modes">A: {answers.modes?.auto || 0}</span>
                </div>
              </div>
            </div>
          </div>
          <div></div>
        </div>

        {/* Review Progress Ring/Breakdown Card */}
        <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div className="card-header" style={{ marginBottom: 12 }}>
              <span className="card-title">🎯 Review Operations</span>
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              {/* Simplistic visual circular indicator */}
              <div style={{
                width: 70,
                height: 70,
                borderRadius: "50%",
                background: `conic-gradient(var(--success) ${review.total > 0 ? (review.reviewed / review.total) * 360 : 0}deg, var(--border) 0deg)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: 14,
                color: "var(--text-bright)",
                boxShadow: "inset 0 0 8px rgba(0,0,0,0.5)"
              }}>
                <div style={{
                  width: 54,
                  height: 54,
                  borderRadius: "50%",
                  background: "var(--card)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12
                }}>
                  {review.total > 0 ? `${((review.reviewed / review.total) * 100).toFixed(0)}%` : "0%"}
                </div>
              </div>

              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <span style={{ color: "var(--text-dim)" }}>Total Pairs:</span>
                  <span style={{ fontWeight: 600 }}>{review.total}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <span style={{ color: "var(--success)" }}>Reviewed:</span>
                  <span style={{ fontWeight: 600, color: "var(--success)" }}>{review.reviewed}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <span style={{ color: "var(--warning)" }}>Pending:</span>
                  <span style={{ fontWeight: 600, color: "var(--warning)" }}>{review.pending}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <span style={{ color: "var(--text-dim)" }}>Auto-Approved:</span>
                  <span style={{ fontWeight: 600 }}>{review.auto_accepted}</span>
                </div>
              </div>
            </div>
          </div>
          <div></div>
        </div>
      </div>

      {/* Second row: Cost breakdown chart & Confidence spread */}
      <div className="grid-2" style={{ marginBottom: 28 }}>
        {/* Cost breakdown */}
        <div className="card">
          <div className="card-header" style={{ marginBottom: 16 }}>
            <span className="card-title">💰 API Cost & Performance Breakdown</span>
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 16 }}>
            <div>
              <div className="card-value" style={{ margin: 0, fontSize: 32 }}>${(cost.total_spent || 0).toFixed(2)}</div>
              <div className="card-label">of ${(cost.budget_limit || 25).toFixed(2)} limit</div>
            </div>
            <div style={{ borderLeft: "1px solid var(--border)", paddingLeft: 16 }}>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Calls Counter</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text-bright)" }}>{cost.api_calls_made || 0} requests</div>
            </div>
          </div>
          
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {cost.breakdown && Object.keys(cost.breakdown).length > 0 ? (
              Object.entries(cost.breakdown).map(([task, val], i) => {
                const percentage = cost.total_spent > 0 ? (val / cost.total_spent) * 100 : 0;
                return (
                  <div key={i}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                      <span style={{ textTransform: "capitalize", fontWeight: 600 }}>{task.replace("_", " ")}</span>
                      <span style={{ color: "var(--text-dim)" }}>${val.toFixed(3)} ({percentage.toFixed(0)}%)</span>
                    </div>
                    <div className="progress-bar-container" style={{ height: 6 }}>
                      <div className="progress-bar-fill" style={{ width: `${percentage}%`, background: "var(--accent)" }} />
                    </div>
                  </div>
                );
              })
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center", padding: "12px 0" }}>
                No task breakdown details available.
              </div>
            )}
          </div>
        </div>

        {/* Confidence distribution */}
        <div className="card">
          <div className="card-header" style={{ marginBottom: 16 }}>
            <span className="card-title">🎯 Match Confidence Spread</span>
          </div>
          <ConfidenceBar high={conf.high || 0} medium={conf.medium || 0} low={conf.low || 0} />
          <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
            <ConfidenceStat label="High" value={conf.high || 0} color="var(--success)" />
            <ConfidenceStat label="Medium" value={conf.medium || 0} color="var(--warning)" />
            <ConfidenceStat label="Low" value={conf.low || 0} color="var(--danger)" />
          </div>
          <div style={{ marginTop: 24, fontSize: 12, color: "var(--text-dim)" }}>
            High-confidence matching mappings can be bulk accepted. Low/Medium mappings are recommended for manual verification.
          </div>
        </div>
      </div>

      {/* Subjects expandable breakdown */}
      <div className="grid-2">
        {/* Subjects */}
        <div className="card">
          <div className="card-header" style={{ marginBottom: 16 }}>
            <span className="card-title">📚 Subject Database</span>
          </div>
          {(stats.subjects || []).length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "16px 0" }}>
              No subjects yet. Upload a textbook to get started.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {stats.subjects.map((s, i) => {
                const isExpanded = expandedSubject === s.name;
                const details = subDetails[s.name] || {};
                
                return (
                  <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
                    <div
                      onClick={() => setExpandedSubject(isExpanded ? null : s.name)}
                      style={{
                        padding: "12px 16px",
                        background: "rgba(255,255,255,0.01)",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        transition: "background 0.2s"
                      }}
                      onMouseOver={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                      onMouseOut={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.01)"}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className={`status-dot ${s.status === "completed" ? "completed" : s.status === "in_progress" ? "in-progress" : "pending"}`} />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-bright)" }}>{s.name}</div>
                          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                            {s.textbooks || 0} textbooks · {s.chapters || 0} chapters · {s.qps || 0} QPs
                          </div>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className={`badge badge-${s.status === "completed" ? "high" : s.status === "in_progress" ? "medium" : "info"}`}>
                          {s.status || "pending"}
                        </span>
                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{isExpanded ? "▲" : "▼"}</span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: 14, background: "rgba(0,0,0,0.2)", borderTop: "1px solid var(--border)", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, fontSize: 12 }}>
                        <div>
                          <div style={{ color: "var(--text-dim)", marginBottom: 2 }}>Textbooks</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-bright)" }}>{details.textbooks || 0}</div>
                        </div>
                        <div>
                          <div style={{ color: "var(--text-dim)", marginBottom: 2 }}>Chapters</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-bright)" }}>{details.chapters || 0}</div>
                        </div>
                        <div>
                          <div style={{ color: "var(--text-dim)", marginBottom: 2 }}>QPs</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-bright)" }}>{details.qps || 0}</div>
                        </div>
                        <div>
                          <div style={{ color: "var(--text-dim)", marginBottom: 2 }}>Questions</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-bright)" }}>{details.questions || 0}</div>
                        </div>
                        <div>
                          <div style={{ color: "var(--text-dim)", marginBottom: 2 }}>Matched</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-bright)" }}>{details.mappings || 0}</div>
                        </div>
                        <div>
                          <div style={{ color: "var(--text-dim)", marginBottom: 2 }}>Reviewed</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--success)" }}>{details.reviewed || 0}</div>
                        </div>
                        <div>
                          <div style={{ color: "var(--text-dim)", marginBottom: 2 }}>Answers Generated</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>{details.answered || 0}</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="card">
          <div className="card-header" style={{ marginBottom: 16 }}>
            <span className="card-title">🕐 Recent Pipeline Activity</span>
          </div>
          {(stats.recent_activity || []).length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "16px 0" }}>
              No activity yet.
            </div>
          ) : (
            <div>
              {stats.recent_activity.slice(0, 8).map((a, i) => (
                <div key={i} className="activity-item" style={{ borderBottom: i < 7 ? "1px solid var(--border)" : "none", paddingBottom: 10, paddingTop: i > 0 ? 10 : 0 }}>
                  <span style={{ fontSize: 16, marginRight: 10 }}>
                    {a.level === "error" ? "🔴" : a.level === "warning" ? "🟡" : "🟢"}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: "var(--text-bright)" }}>{a.message}</div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
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

