"use client";
import { useState, useEffect } from "react";
import {
  getMappings, getChapters, getAnswerForMapping, generateAnswers,
  updateAnswer, deleteAnswer, connectProgress,
} from "@/lib/api";

const PRESETS = {
  LAQ:  { label: "LAQ", desc: "15-20 detailed bullets", min: 15, max: 20, style: "detailed" },
  SAQ:  { label: "SAQ", desc: "8-12 detailed bullets", min: 8, max: 12, style: "detailed" },
  VSAQ: { label: "VSAQ", desc: "7-8 precise bullets", min: 7, max: 8, style: "precise" },
};

export default function AnswersPage() {
  const [mappings, setMappings] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);
  const [preset, setPreset] = useState("SAQ");
  const [customCount, setCustomCount] = useState(10);
  const [customStyle, setCustomStyle] = useState("detailed");
  const [filterChapter, setFilterChapter] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(null);
  const [viewAnswer, setViewAnswer] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [m, ch] = await Promise.all([
        getMappings(null, null),
        getChapters(),
      ]);
      // Only show accepted/high-confidence mappings
      const eligible = m.filter(x => x.is_reviewed || x.confidence_level === "high");
      setMappings(eligible);
      setChapters(ch);

      // Load answers for all mappings
      const ansMap = {};
      for (const mapping of eligible) {
        try {
          const ans = await getAnswerForMapping(mapping.id);
          if (ans && ans.id) ansMap[mapping.id] = ans;
        } catch { /* no answer yet */ }
      }
      setAnswers(ansMap);
    } catch (err) { showToast("Load failed: " + err.message, "error"); }
    setLoading(false);
  }

  function showToast(msg, type = "info") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  function toggleSelect(id) {
    setSelected(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 5) { showToast("Maximum 5 questions per batch", "error"); return prev; }
      return [...prev, id];
    });
  }

  function selectAll() {
    const visible = filteredMappings.filter(m => !answers[m.id]).slice(0, 5).map(m => m.id);
    setSelected(visible);
  }

  async function handleGenerate() {
    if (selected.length === 0) return;
    setGenerating(true);
    setGenProgress(null);
    try {
      const res = await generateAnswers(
        selected,
        preset,
        preset === "custom" ? customCount : null,
        preset === "custom" ? customStyle : null,
      );
      if (res.task_id) {
        connectProgress(res.task_id, (data) => {
          setGenProgress(data);
          if (data.step === "done") {
            showToast("Answers generated!", "success");
            setSelected([]);
            setGenerating(false);
            setGenProgress(null);
            loadData();
          }
          if (data.step === "error") {
            showToast("Error: " + data.message, "error");
            setGenerating(false);
          }
        }, () => {
          showToast("Connection lost", "error");
          setGenerating(false);
        });
      }
    } catch (err) {
      showToast("Generation failed: " + err.message, "error");
      setGenerating(false);
    }
  }

  async function handleDeleteAnswer(answerId, mappingId) {
    if (!confirm("Delete this answer?")) return;
    try {
      await deleteAnswer(answerId);
      setAnswers(prev => { const n = { ...prev }; delete n[mappingId]; return n; });
      if (viewAnswer?.id === answerId) setViewAnswer(null);
      showToast("Answer deleted", "success");
    } catch (err) { showToast("Delete failed", "error"); }
  }

  const filteredMappings = mappings.filter(m => {
    if (filterChapter && m.final_chapter_id !== filterChapter) return false;
    if (filterStatus === "answered" && !answers[m.id]) return false;
    if (filterStatus === "unanswered" && answers[m.id]) return false;
    return true;
  });

  const answeredCount = mappings.filter(m => answers[m.id]).length;
  const unansweredCount = mappings.length - answeredCount;

  // Group by chapter for display
  const groupedByChapter = {};
  for (const m of filteredMappings) {
    const ch = m.final_chapter_name || "Unassigned";
    if (!groupedByChapter[ch]) groupedByChapter[ch] = [];
    groupedByChapter[ch].push(m);
  }

  // Cost estimate
  const bulletCount = preset === "custom" ? customCount : Math.round((PRESETS[preset]?.min + PRESETS[preset]?.max) / 2);
  const estimatedCost = (selected.length * (2000 * 1 + bulletCount * 50 * 5) / 1_000_000).toFixed(4);

  if (loading) return <div className="loading-overlay"><div className="spinner" /> Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">✍️ Answer Generator</h1>
          <p className="page-subtitle">Generate textbook-sourced answers for matched questions</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>
            {answeredCount}/{mappings.length} answered
          </span>
          <button className="btn btn-secondary btn-sm" onClick={loadData}>↻</button>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilterStatus("all")}>
          <div className="stat-value">{mappings.length}</div>
          <div className="stat-label">Total Eligible</div>
        </div>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilterStatus("answered")}>
          <div className="stat-value" style={{ color: "var(--success)" }}>{answeredCount}</div>
          <div className="stat-label">Answered</div>
        </div>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilterStatus("unanswered")}>
          <div className="stat-value" style={{ color: "var(--warning)" }}>{unansweredCount}</div>
          <div className="stat-label">Unanswered</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{selected.length}/5</div>
          <div className="stat-label">Selected</div>
        </div>
      </div>

      {/* Generation Controls */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          {/* Preset selector */}
          <div className="input-group" style={{ minWidth: 120 }}>
            <label className="input-label">Preset</label>
            <div style={{ display: "flex", gap: 4 }}>
              {["LAQ", "SAQ", "VSAQ", "custom"].map(p => (
                <button key={p} className={`btn btn-sm ${preset === p ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setPreset(p)} style={{ fontSize: 11, padding: "4px 10px" }}>
                  {p}
                </button>
              ))}
            </div>
          </div>

          {preset !== "custom" && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "6px 0" }}>
              {PRESETS[preset]?.desc}
            </div>
          )}

          {preset === "custom" && (
            <>
              <div className="input-group" style={{ width: 100 }}>
                <label className="input-label">Bullets</label>
                <input className="input" type="number" min={3} max={25} value={customCount}
                  onChange={e => setCustomCount(parseInt(e.target.value) || 8)} />
              </div>
              <div className="input-group" style={{ width: 130 }}>
                <label className="input-label">Style</label>
                <select className="select" value={customStyle} onChange={e => setCustomStyle(e.target.value)}>
                  <option value="detailed">Detailed</option>
                  <option value="precise">Precise</option>
                </select>
              </div>
            </>
          )}

          <div className="input-group" style={{ width: 180 }}>
            <label className="input-label">Filter: Chapter</label>
            <select className="select" value={filterChapter} onChange={e => setFilterChapter(e.target.value)}>
              <option value="">All Chapters</option>
              {chapters.map(ch => (
                <option key={ch.id} value={ch.id}>Ch {ch.chapter_number}: {ch.name}</option>
              ))}
            </select>
          </div>

          <div style={{ flex: 1 }} />

          {selected.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--mono)", paddingBottom: 6 }}>
              Est. ~${estimatedCost}
            </div>
          )}

          <button className="btn btn-sm btn-secondary" onClick={selectAll} disabled={generating}>
            Select 5
          </button>
          <button className="btn btn-primary" onClick={handleGenerate}
            disabled={generating || selected.length === 0}>
            {generating ? "Generating..." : `✍️ Generate (${selected.length})`}
          </button>
        </div>

        {/* Progress */}
        {genProgress && genProgress.step !== "done" && genProgress.step !== "error" && (
          <div style={{ marginTop: 12 }}>
            <div className="progress-bar-container">
              <div className="progress-bar-fill" style={{ width: `${genProgress.percentage || 0}%` }} />
            </div>
            <div className="progress-text">
              <span>{genProgress.message}</span>
              <span>{(genProgress.percentage || 0).toFixed(0)}%</span>
            </div>
          </div>
        )}
      </div>

      {/* Question List (grouped by chapter) */}
      <div style={{ display: "flex", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {Object.entries(groupedByChapter).length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">✍️</div>
              <div className="empty-state-title">No eligible questions</div>
              <div className="empty-state-text">Run matching and review questions first</div>
            </div>
          ) : (
            Object.entries(groupedByChapter).map(([chName, items]) => (
              <div key={chName} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", marginBottom: 6, fontFamily: "var(--mono)", letterSpacing: 0.5 }}>
                  📖 {chName} ({items.length})
                </div>
                {items.map((m) => {
                  const ans = answers[m.id];
                  const isSelected = selected.includes(m.id);
                  return (
                    <div key={m.id} className="question-row" style={{
                      display: "flex", gap: 10, alignItems: "flex-start",
                      padding: "8px 12px", borderRadius: "var(--r)", marginBottom: 4,
                      background: isSelected ? "rgba(77,127,255,0.08)" : "var(--surface)",
                      border: `1px solid ${isSelected ? "rgba(77,127,255,0.3)" : "var(--border)"}`,
                      cursor: "pointer", transition: "all var(--t)",
                    }}
                      onClick={() => ans ? setViewAnswer(ans) : toggleSelect(m.id)}
                    >
                      {/* Checkbox */}
                      <div style={{ paddingTop: 2, flexShrink: 0 }}
                        onClick={e => { e.stopPropagation(); toggleSelect(m.id); }}>
                        <div style={{
                          width: 18, height: 18, borderRadius: 4,
                          border: `2px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
                          background: isSelected ? "var(--accent)" : "transparent",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 11, color: "#fff", transition: "all var(--t)",
                        }}>
                          {isSelected && "✓"}
                        </div>
                      </div>

                      {/* Question text */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.4 }}>
                          {m.question_text?.substring(0, 120)}{m.question_text?.length > 120 ? "..." : ""}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3, fontFamily: "var(--mono)" }}>
                          {m.question_type} · {((m.confidence || 0) * 100).toFixed(0)}%
                        </div>
                      </div>

                      {/* Answer status */}
                      {ans ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                          <span className="badge badge-high" style={{ fontSize: 10 }}>
                            {ans.preset} · {ans.bullet_count}pt
                          </span>
                          <button className="btn btn-sm"
                            style={{ fontSize: 10, padding: "2px 6px", background: "transparent", color: "var(--accent)", border: "1px solid var(--border)" }}
                            onClick={e => { e.stopPropagation(); setViewAnswer(ans); }}>
                            👁
                          </button>
                        </div>
                      ) : (
                        <span className="badge badge-medium" style={{ fontSize: 10, flexShrink: 0 }}>
                          unanswered
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Answer Preview Panel */}
        {viewAnswer && (
          <AnswerPreview
            answer={viewAnswer}
            onClose={() => setViewAnswer(null)}
            onDelete={() => handleDeleteAnswer(viewAnswer.id, viewAnswer.mapping_id)}
            onEdit={async (data) => {
              try {
                await updateAnswer(viewAnswer.id, data);
                showToast("Answer updated", "success");
                loadData();
                setViewAnswer(null);
              } catch (err) { showToast("Update failed", "error"); }
            }}
          />
        )}
      </div>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

function AnswerPreview({ answer, onClose, onDelete, onEdit }) {
  const [editing, setEditing] = useState(false);
  const [editPrologue, setEditPrologue] = useState(answer.prologue);
  const [editBullets, setEditBullets] = useState(answer.bullets || []);
  const [editEpilogue, setEditEpilogue] = useState(answer.epilogue);

  useEffect(() => {
    setEditPrologue(answer.prologue);
    setEditBullets(answer.bullets || []);
    setEditEpilogue(answer.epilogue);
    setEditing(false);
  }, [answer.id]);

  function updateBullet(idx, val) {
    setEditBullets(prev => prev.map((b, i) => i === idx ? val : b));
  }

  function addBullet() {
    setEditBullets(prev => [...prev, ""]);
  }

  function removeBullet(idx) {
    setEditBullets(prev => prev.filter((_, i) => i !== idx));
  }

  const pages = answer.source_pages ? Object.entries(answer.source_pages) : [];

  return (
    <div style={{
      width: 420, flexShrink: 0, background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: "var(--r)", padding: 16, position: "sticky", top: 16, maxHeight: "calc(100vh - 120px)",
      overflowY: "auto",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className={`badge badge-${answer.status === "edited" ? "medium" : "high"}`} style={{ fontSize: 10 }}>
            {answer.preset} · {answer.bullet_count} bullets
          </span>
          <span className="badge badge-info" style={{ fontSize: 10 }}>{answer.status}</span>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={onClose} style={{ fontSize: 11 }}>✕</button>
      </div>

      {/* Question */}
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-bright)", marginBottom: 10, lineHeight: 1.4 }}>
        {answer.question_text}
      </div>

      {/* Chapter & Source */}
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 14, fontFamily: "var(--mono)" }}>
        📖 {answer.chapter_name}
        {pages.length > 0 && <> · {pages.map(([k, v]) => `${k}: ${v}`).join(", ")}</>}
      </div>

      {editing ? (
        /* Edit mode */
        <div>
          <div className="input-group" style={{ marginBottom: 10 }}>
            <label className="input-label">Prologue</label>
            <textarea className="input" rows={2} value={editPrologue}
              onChange={e => setEditPrologue(e.target.value)}
              style={{ resize: "vertical", fontFamily: "inherit" }} />
          </div>

          <div className="input-label" style={{ marginBottom: 6 }}>
            Bullets ({editBullets.length})
            <button className="btn btn-sm" style={{ marginLeft: 8, fontSize: 10, padding: "2px 8px" }}
              onClick={addBullet}>+ Add</button>
          </div>
          {editBullets.map((b, i) => (
            <div key={i} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)", minWidth: 18, paddingTop: 8 }}>{i + 1}.</span>
              <textarea className="input" rows={1} value={b}
                onChange={e => updateBullet(i, e.target.value)}
                style={{ flex: 1, resize: "vertical", fontSize: 12 }} />
              <button className="btn btn-sm"
                style={{ fontSize: 10, padding: "4px 6px", color: "var(--danger)", background: "transparent" }}
                onClick={() => removeBullet(i)}>✕</button>
            </div>
          ))}

          <div className="input-group" style={{ marginTop: 10 }}>
            <label className="input-label">Epilogue</label>
            <textarea className="input" rows={2} value={editEpilogue}
              onChange={e => setEditEpilogue(e.target.value)}
              style={{ resize: "vertical", fontFamily: "inherit" }} />
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={() => {
              onEdit({ prologue: editPrologue, bullets: editBullets, epilogue: editEpilogue });
            }}>💾 Save</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        /* View mode */
        <div>
          {/* Prologue */}
          {answer.prologue && (
            <div style={{
              fontSize: 13, color: "var(--text)", fontStyle: "italic", marginBottom: 12,
              padding: "8px 12px", background: "rgba(77,127,255,0.05)", borderRadius: 6,
              borderLeft: "3px solid var(--accent)", lineHeight: 1.5,
            }}>
              {answer.prologue}
            </div>
          )}

          {/* Bullets */}
          <div style={{ marginBottom: 12 }}>
            {(answer.bullets || []).map((b, i) => (
              <div key={i} style={{
                display: "flex", gap: 8, padding: "5px 0",
                borderBottom: "1px solid rgba(255,255,255,0.03)",
              }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: "var(--accent)",
                  minWidth: 20, fontFamily: "var(--mono)",
                }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.5 }}>{b}</span>
              </div>
            ))}
          </div>

          {/* Epilogue */}
          {answer.epilogue && (
            <div style={{
              fontSize: 13, color: "var(--text)", fontStyle: "italic", marginBottom: 12,
              padding: "8px 12px", background: "rgba(52,211,153,0.05)", borderRadius: 6,
              borderLeft: "3px solid var(--success)", lineHeight: 1.5,
            }}>
              {answer.epilogue}
            </div>
          )}

          {/* Images */}
          {answer.images && answer.images.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>
                📸 Reference Images ({answer.images.length})
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {answer.images.map((img, ii) => {
                  const tbId = img.filename?.split("_p")[0] || "unknown";
                  return (
                    <div key={ii} style={{
                      border: "1px solid var(--border)", borderRadius: 6,
                      overflow: "hidden", maxWidth: 180, background: "var(--bg)",
                    }}>
                      <img
                        src={`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/images/${tbId}/${img.filename}`}
                        alt={img.caption || `Page ${img.page}`}
                        style={{ maxWidth: "100%", maxHeight: 160, objectFit: "contain", display: "block", cursor: "pointer" }}
                        onClick={() => window.open(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/images/${tbId}/${img.filename}`, "_blank")}
                        onError={e => { e.target.style.display = "none"; }}
                      />
                      <div style={{ padding: "3px 6px", fontSize: 9, color: "var(--text-dim)" }}>
                        p.{img.page}{img.caption ? ` — ${img.caption.substring(0, 80)}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>✏️ Edit</button>
            <button className="btn btn-sm"
              style={{ background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid rgba(248,113,113,0.3)" }}
              onClick={onDelete}>🗑 Delete</button>
          </div>

          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 10, fontFamily: "var(--mono)" }}>
            Generated {answer.generated_at ? new Date(answer.generated_at).toLocaleString() : "—"}
            {answer.model_used && ` · ${answer.model_used}`}
          </div>
        </div>
      )}
    </div>
  );
}
