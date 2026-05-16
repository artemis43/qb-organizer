"use client";
import { useState, useEffect } from "react";
import {
  getSubjects, getTextbooks, getTextbookChapters,
  vivaGenerate, getVivaQuestions, getVivaStats, addVivaManual,
  updateVivaQuestion, deleteVivaQuestion, deleteVivaQuestions,
  vivaAutoTag, vivaPushToFirestore, getVivaFirestoreStatus,
  connectProgress,
} from "@/lib/api";

const IMPORTANCE_COLORS = {
  must_know: { bg: "rgba(239,68,68,0.12)", color: "#f87171", label: "🔴 Must-Know" },
  standard:  { bg: "rgba(250,204,21,0.12)", color: "#facc15", label: "🟡 Standard" },
  advanced:  { bg: "rgba(52,211,153,0.12)", color: "#34d399", label: "🟢 Advanced" },
};

export default function VivaPage() {
  const [subjects, setSubjects] = useState([]);
  const [textbooks, setTextbooks] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [stats, setStats] = useState(null);
  const [firestoreStatus, setFirestoreStatus] = useState(null);

  // Selection & filters
  const [selSubject, setSelSubject] = useState("");
  const [selTextbook, setSelTextbook] = useState("");
  const [selChapters, setSelChapters] = useState([]);
  const [qPerChapter, setQPerChapter] = useState(8);
  const [filterImportance, setFilterImportance] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [selected, setSelected] = useState([]);

  // UI state
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [toast, setToast] = useState(null);
  const [viewQuestion, setViewQuestion] = useState(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [tab, setTab] = useState("generate"); // generate | questions | manual

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (selSubject) {
      const tbs = textbooks.filter(t => t.subject === selSubject);
      if (tbs.length > 0 && !selTextbook) setSelTextbook(tbs[0].id);
    }
  }, [selSubject, textbooks]);

  useEffect(() => {
    if (selTextbook) loadChapters(selTextbook);
  }, [selTextbook]);

  async function loadData() {
    setLoading(true);
    try {
      const [s, tb, q, st, fs] = await Promise.all([
        getSubjects(), getTextbooks(), getVivaQuestions(),
        getVivaStats(), getVivaFirestoreStatus(),
      ]);
      setSubjects(s);
      setTextbooks(tb);
      setQuestions(q);
      setStats(st);
      setFirestoreStatus(fs);
      if (s.length > 0 && !selSubject) setSelSubject(s[0].subject);
    } catch (err) { showToast("Load failed: " + err.message, "error"); }
    setLoading(false);
  }

  async function loadChapters(tbId) {
    try {
      const res = await getTextbookChapters(tbId);
      setChapters(res.chapters || []);
    } catch { setChapters([]); }
  }

  async function loadQuestions() {
    try {
      const q = await getVivaQuestions(selSubject || null, filterStatus || null, filterImportance || null);
      setQuestions(q);
      const st = await getVivaStats();
      setStats(st);
    } catch { }
  }

  function showToast(msg, type = "info") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  function toggleSelect(id) {
    setSelected(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  }

  function selectAll() {
    setSelected(filteredQuestions.map(q => q.id));
  }

  function selectNone() { setSelected([]); }

  // ── Generate ──
  async function handleGenerate() {
    if (!selTextbook) return showToast("Select a textbook first", "error");
    setGenerating(true);
    setProgress(null);
    try {
      const res = await vivaGenerate(selSubject, selTextbook, selChapters.length > 0 ? selChapters : null, qPerChapter);
      if (res.task_id) {
        connectProgress(res.task_id, (data) => {
          setProgress(data);
          if (data.step === "done") {
            showToast("Viva questions generated!", "success");
            setGenerating(false);
            setProgress(null);
            setTab("questions");
            loadQuestions();
          }
          if (data.step === "error") {
            showToast("Error: " + data.message, "error");
            setGenerating(false);
          }
        }, () => { setGenerating(false); });
      }
    } catch (err) {
      showToast("Generation failed: " + err.message, "error");
      setGenerating(false);
    }
  }

  // ── Push to Firestore ──
  async function handlePush() {
    if (selected.length === 0) return showToast("Select questions to push", "error");
    if (!firestoreStatus?.connected) return showToast("Firestore not connected. Add service account.", "error");

    setPushing(true);
    setProgress(null);
    try {
      const res = await vivaPushToFirestore(selected);
      if (res.task_id) {
        connectProgress(res.task_id, (data) => {
          setProgress(data);
          if (data.step === "done") {
            const result = JSON.parse(data.message);
            showToast(`Pushed ${result.questions} questions to Firestore!`, "success");
            setPushing(false);
            setProgress(null);
            setSelected([]);
            loadQuestions();
          }
          if (data.step === "error") {
            showToast("Push error: " + data.message, "error");
            setPushing(false);
          }
        }, () => { setPushing(false); });
      }
    } catch (err) {
      showToast("Push failed: " + err.message, "error");
      setPushing(false);
    }
  }

  // ── Auto-tag ──
  async function handleAutoTag() {
    if (selected.length === 0) return showToast("Select questions to tag", "error");
    try {
      const res = await vivaAutoTag(selected, selSubject);
      if (res.task_id) {
        connectProgress(res.task_id, (data) => {
          if (data.step === "done") {
            showToast("Auto-tagging complete!", "success");
            loadQuestions();
          }
        });
      }
    } catch (err) { showToast("Tag failed: " + err.message, "error"); }
  }

  // ── Delete ──
  async function handleDeleteSelected() {
    if (!confirm(`Delete ${selected.length} selected questions?`)) return;
    for (const id of selected) {
      try { await deleteVivaQuestion(id); } catch { }
    }
    setSelected([]);
    loadQuestions();
    showToast("Deleted", "success");
  }

  const filteredQuestions = questions.filter(q => {
    if (filterImportance && q.importance !== filterImportance) return false;
    if (filterStatus && q.status !== filterStatus) return false;
    return true;
  });

  // Group by chapter → topic
  const grouped = {};
  for (const q of filteredQuestions) {
    const ch = q.chapter_name || "Unknown";
    if (!grouped[ch]) grouped[ch] = {};
    const topic = q.topic_name || "General";
    if (!grouped[ch][topic]) grouped[ch][topic] = [];
    grouped[ch][topic].push(q);
  }

  const subjectTextbooks = textbooks.filter(t => t.subject === selSubject);
  const totalQ = stats?.total_questions || 0;
  const subjectStats = stats?.by_subject?.[selSubject] || {};

  if (loading) return <div className="loading-overlay"><div className="spinner" /> Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">🎤 Viva Organizer</h1>
          <p className="page-subtitle">Generate, review, and push viva questions to Firestore</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{
            fontSize: 11, padding: "4px 10px", borderRadius: 6, fontFamily: "var(--mono)",
            background: firestoreStatus?.connected ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)",
            color: firestoreStatus?.connected ? "var(--success)" : "var(--danger)",
          }}>
            {firestoreStatus?.connected ? "🟢 Firestore" : "🔴 No Firestore"}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={loadData}>↻</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {[
          { key: "generate", label: "⚡ Generate", count: null },
          { key: "questions", label: "📋 Questions", count: totalQ },
          { key: "manual", label: "✏️ Manual Entry", count: null },
        ].map(t => (
          <button key={t.key}
            className={`btn btn-sm ${tab === t.key ? "btn-primary" : "btn-secondary"}`}
            onClick={() => { setTab(t.key); if (t.key === "questions") loadQuestions(); }}
            style={{ fontSize: 12 }}>
            {t.label}{t.count != null ? ` (${t.count})` : ""}
          </button>
        ))}
      </div>

      {/* Stats Bar */}
      {totalQ > 0 && (
        <div className="grid-4" style={{ marginBottom: 16 }}>
          <div className="stat-card">
            <div className="stat-value">{subjectStats.total || 0}</div>
            <div className="stat-label">Total Questions</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: "#f87171" }}>{subjectStats.must_know || 0}</div>
            <div className="stat-label">Must-Know</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: "var(--success)" }}>{subjectStats.pushed || 0}</div>
            <div className="stat-label">Pushed</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{selected.length}</div>
            <div className="stat-label">Selected</div>
          </div>
        </div>
      )}

      {/* ── Generate Tab ── */}
      {tab === "generate" && (
        <div className="card">
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: "var(--text-bright)" }}>
            Generate Viva Questions from Textbook
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <div className="input-group" style={{ width: 180 }}>
              <label className="input-label">Subject</label>
              <select className="select" value={selSubject} onChange={e => { setSelSubject(e.target.value); setSelTextbook(""); setSelChapters([]); }}>
                <option value="">Select...</option>
                {subjects.map(s => <option key={s.subject} value={s.subject}>{s.subject}</option>)}
              </select>
            </div>

            <div className="input-group" style={{ width: 250 }}>
              <label className="input-label">Textbook</label>
              <select className="select" value={selTextbook} onChange={e => { setSelTextbook(e.target.value); setSelChapters([]); }}>
                <option value="">Select...</option>
                {subjectTextbooks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>

            <div className="input-group" style={{ width: 100 }}>
              <label className="input-label">Q/Chapter</label>
              <input className="input" type="number" min={3} max={15} value={qPerChapter}
                onChange={e => setQPerChapter(parseInt(e.target.value) || 8)} />
            </div>
          </div>

          {/* Chapter selector */}
          {chapters.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                Chapters ({selChapters.length === 0 ? "All" : selChapters.length + " selected"})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                <button className={`btn btn-sm ${selChapters.length === 0 ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setSelChapters([])} style={{ fontSize: 10 }}>All</button>
                {chapters.map(ch => (
                  <button key={ch.id}
                    className={`btn btn-sm ${selChapters.includes(ch.id) ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => setSelChapters(p => p.includes(ch.id) ? p.filter(x => x !== ch.id) : [...p, ch.id])}
                    style={{ fontSize: 10 }}>
                    Ch {ch.chapter_number}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button className="btn btn-primary" onClick={handleGenerate} disabled={generating || !selTextbook}>
            {generating ? "Generating..." : `⚡ Generate Viva Questions`}
          </button>

          {/* Progress */}
          {progress && progress.step !== "done" && progress.step !== "error" && (
            <div style={{ marginTop: 12 }}>
              <div className="progress-bar-container">
                <div className="progress-bar-fill" style={{ width: `${progress.percentage || 0}%` }} />
              </div>
              <div className="progress-text">
                <span>{progress.message}</span>
                <span>{(progress.percentage || 0).toFixed(0)}%</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Questions Tab ── */}
      {tab === "questions" && (
        <div>
          {/* Toolbar */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <div className="input-group" style={{ width: 140 }}>
                <label className="input-label">Importance</label>
                <select className="select" value={filterImportance} onChange={e => { setFilterImportance(e.target.value); setTimeout(loadQuestions, 0); }}>
                  <option value="">All</option>
                  <option value="must_know">🔴 Must-Know</option>
                  <option value="standard">🟡 Standard</option>
                  <option value="advanced">🟢 Advanced</option>
                </select>
              </div>

              <div className="input-group" style={{ width: 120 }}>
                <label className="input-label">Status</label>
                <select className="select" value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setTimeout(loadQuestions, 0); }}>
                  <option value="">All</option>
                  <option value="generated">Generated</option>
                  <option value="reviewed">Reviewed</option>
                  <option value="pushed">Pushed</option>
                </select>
              </div>

              <div style={{ flex: 1 }} />

              <button className="btn btn-sm btn-secondary" onClick={selectAll}>Select All</button>
              <button className="btn btn-sm btn-secondary" onClick={selectNone}>Deselect</button>
              <button className="btn btn-sm btn-secondary" onClick={handleAutoTag} disabled={selected.length === 0}>
                🏷 Re-tag ({selected.length})
              </button>
              <button className="btn btn-sm" onClick={handleDeleteSelected} disabled={selected.length === 0}
                style={{ background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid rgba(248,113,113,0.3)" }}>
                🗑 Delete ({selected.length})
              </button>
              <button className="btn btn-primary btn-sm" onClick={handlePush}
                disabled={selected.length === 0 || pushing || !firestoreStatus?.connected}>
                {pushing ? "Pushing..." : `🚀 Push to Firestore (${selected.length})`}
              </button>
            </div>

            {/* Push progress */}
            {pushing && progress && progress.step !== "done" && (
              <div style={{ marginTop: 10 }}>
                <div className="progress-bar-container">
                  <div className="progress-bar-fill" style={{ width: `${progress.percentage || 0}%` }} />
                </div>
                <div className="progress-text">
                  <span>{progress.message}</span>
                </div>
              </div>
            )}
          </div>

          {/* Question List */}
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {Object.keys(grouped).length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">🎤</div>
                  <div className="empty-state-title">No viva questions yet</div>
                  <div className="empty-state-text">Generate questions from a textbook or add manually</div>
                </div>
              ) : (
                Object.entries(grouped).map(([chName, topics]) => (
                  <div key={chName} style={{ marginBottom: 20 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 700, color: "var(--accent)", marginBottom: 8,
                      fontFamily: "var(--mono)", letterSpacing: 0.5,
                    }}>
                      📖 {chName} ({Object.values(topics).flat().length})
                    </div>

                    {Object.entries(topics).map(([topicName, topicQuestions]) => (
                      <div key={topicName} style={{ marginBottom: 12, marginLeft: 12 }}>
                        <div style={{
                          fontSize: 11, fontWeight: 600, color: "var(--text-dim)",
                          marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5,
                        }}>
                          ▸ {topicName} ({topicQuestions.length})
                        </div>

                        {topicQuestions.map(q => {
                          const imp = IMPORTANCE_COLORS[q.importance] || IMPORTANCE_COLORS.standard;
                          const isSelected = selected.includes(q.id);
                          return (
                            <div key={q.id} style={{
                              display: "flex", gap: 10, alignItems: "flex-start",
                              padding: "8px 12px", borderRadius: "var(--r)", marginBottom: 4,
                              background: isSelected ? "rgba(77,127,255,0.08)" : "var(--surface)",
                              border: `1px solid ${isSelected ? "rgba(77,127,255,0.3)" : "var(--border)"}`,
                              cursor: "pointer", transition: "all var(--t)",
                            }} onClick={() => setViewQuestion(q)}>

                              {/* Checkbox */}
                              <div style={{ paddingTop: 2, flexShrink: 0 }}
                                onClick={e => { e.stopPropagation(); toggleSelect(q.id); }}>
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

                              {/* Content */}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.4 }}>
                                  {q.question_text}
                                </div>
                                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3, display: "flex", gap: 6, flexWrap: "wrap" }}>
                                  <span style={{
                                    padding: "1px 6px", borderRadius: 4, fontSize: 10,
                                    background: imp.bg, color: imp.color,
                                  }}>
                                    {imp.label}
                                  </span>
                                  {q.explained_terms?.length > 0 && (
                                    <span style={{ fontFamily: "var(--mono)" }}>
                                      🏷 {q.explained_terms.length} terms
                                    </span>
                                  )}
                                  {q.status === "pushed" && <span style={{ color: "var(--success)" }}>✅ Pushed</span>}
                                  {q.is_manual && <span>✏️ Manual</span>}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>

            {/* Detail Panel */}
            {viewQuestion && (
              <QuestionDetailPanel
                question={viewQuestion}
                onClose={() => setViewQuestion(null)}
                onSave={async (data) => {
                  try {
                    await updateVivaQuestion(viewQuestion.id, data);
                    showToast("Updated", "success");
                    loadQuestions();
                    setViewQuestion(null);
                  } catch (err) { showToast("Update failed", "error"); }
                }}
                onDelete={async () => {
                  if (!confirm("Delete this question?")) return;
                  try {
                    await deleteVivaQuestion(viewQuestion.id);
                    showToast("Deleted", "success");
                    setViewQuestion(null);
                    loadQuestions();
                  } catch { showToast("Delete failed", "error"); }
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Manual Entry Tab ── */}
      {tab === "manual" && (
        <ManualEntryForm
          subjects={subjects}
          defaultSubject={selSubject}
          onSubmit={async (data) => {
            try {
              const res = await addVivaManual(data);
              showToast(`Added! ${res.explained_terms?.length || 0} terms auto-tagged.`, "success");
              loadQuestions();
            } catch (err) { showToast("Failed: " + err.message, "error"); }
          }}
        />
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}


function QuestionDetailPanel({ question, onClose, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [editQ, setEditQ] = useState(question.question_text);
  const [editA, setEditA] = useState(question.answer_text);
  const [editImp, setEditImp] = useState(question.importance);

  useEffect(() => {
    setEditQ(question.question_text);
    setEditA(question.answer_text);
    setEditImp(question.importance);
    setEditing(false);
  }, [question.id]);

  const imp = IMPORTANCE_COLORS[question.importance] || IMPORTANCE_COLORS.standard;
  const pages = question.source_pages ? Object.entries(question.source_pages) : [];

  return (
    <div style={{
      width: 420, flexShrink: 0, background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: "var(--r)", padding: 16, position: "sticky", top: 16,
      maxHeight: "calc(100vh - 120px)", overflowY: "auto",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, background: imp.bg, color: imp.color }}>
            {imp.label}
          </span>
          <span className="badge badge-info" style={{ fontSize: 10 }}>{question.status}</span>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={onClose} style={{ fontSize: 11 }}>✕</button>
      </div>

      {/* Metadata */}
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 12, fontFamily: "var(--mono)" }}>
        📖 {question.chapter_name} → {question.topic_name}
        {pages.length > 0 && <><br />📄 {pages.map(([k, v]) => `${k}: ${v}`).join(", ")}</>}
      </div>

      {editing ? (
        <div>
          <div className="input-group" style={{ marginBottom: 10 }}>
            <label className="input-label">Question</label>
            <textarea className="input" rows={3} value={editQ} onChange={e => setEditQ(e.target.value)}
              style={{ resize: "vertical" }} />
          </div>
          <div className="input-group" style={{ marginBottom: 10 }}>
            <label className="input-label">Answer</label>
            <textarea className="input" rows={6} value={editA} onChange={e => setEditA(e.target.value)}
              style={{ resize: "vertical" }} />
          </div>
          <div className="input-group" style={{ marginBottom: 10 }}>
            <label className="input-label">Importance</label>
            <select className="select" value={editImp} onChange={e => setEditImp(e.target.value)}>
              <option value="must_know">🔴 Must-Know</option>
              <option value="standard">🟡 Standard</option>
              <option value="advanced">🟢 Advanced</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-primary btn-sm"
              onClick={() => onSave({ question_text: editQ, answer_text: editA, importance: editImp })}>
              💾 Save
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div>
          {/* Question */}
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)", marginBottom: 12, lineHeight: 1.5 }}>
            {question.question_text}
          </div>

          {/* Answer */}
          <div style={{
            fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginBottom: 12,
            padding: "10px 14px", background: "rgba(77,127,255,0.05)", borderRadius: 8,
            borderLeft: "3px solid var(--accent)", whiteSpace: "pre-wrap",
          }}>
            {question.answer_text || <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>No answer generated</span>}
          </div>

          {/* Explained Terms */}
          {question.explained_terms?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>
                🏷 Explained Terms ({question.explained_terms.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {question.explained_terms.map((t, i) => (
                  <span key={i} style={{
                    fontSize: 10, padding: "2px 8px", borderRadius: 10,
                    background: "rgba(77,127,255,0.1)", color: "var(--accent)",
                    border: "1px solid rgba(77,127,255,0.2)",
                  }}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>✏️ Edit</button>
            <button className="btn btn-sm"
              style={{ background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid rgba(248,113,113,0.3)" }}
              onClick={onDelete}>🗑 Delete</button>
          </div>

          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 10, fontFamily: "var(--mono)" }}>
            {question.is_manual ? "✏️ Manually written" : "⚡ Auto-generated"}
            {question.created_at && ` · ${new Date(question.created_at).toLocaleString()}`}
          </div>
        </div>
      )}
    </div>
  );
}


function ManualEntryForm({ subjects, defaultSubject, onSubmit }) {
  const [subject, setSubject] = useState(defaultSubject || "");
  const [chapterName, setChapterName] = useState("");
  const [topicName, setTopicName] = useState("");
  const [questionText, setQuestionText] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [importance, setImportance] = useState("standard");
  const [difficulty, setDifficulty] = useState(1);

  function handleSubmit(e) {
    e.preventDefault();
    if (!subject || !chapterName || !topicName || !questionText || !answerText) return;
    onSubmit({ subject, chapter_name: chapterName, topic_name: topicName, question_text: questionText, answer_text: answerText, importance, difficulty });
    setQuestionText("");
    setAnswerText("");
  }

  return (
    <div className="card">
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: "var(--text-bright)" }}>
        Add Viva Question Manually
      </div>
      <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 16 }}>
        Manually written questions are auto-tagged with explainedTerms on save.
      </p>

      <form onSubmit={handleSubmit}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <div className="input-group" style={{ width: 180 }}>
            <label className="input-label">Subject *</label>
            <select className="select" value={subject} onChange={e => setSubject(e.target.value)} required>
              <option value="">Select...</option>
              {subjects.map(s => <option key={s.subject} value={s.subject}>{s.subject}</option>)}
            </select>
          </div>
          <div className="input-group" style={{ flex: 1, minWidth: 180 }}>
            <label className="input-label">Chapter *</label>
            <input className="input" value={chapterName} onChange={e => setChapterName(e.target.value)} required
              placeholder="e.g. Fractures and Dislocations" />
          </div>
          <div className="input-group" style={{ flex: 1, minWidth: 180 }}>
            <label className="input-label">Topic *</label>
            <input className="input" value={topicName} onChange={e => setTopicName(e.target.value)} required
              placeholder="e.g. Compound Fractures" />
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <div className="input-group" style={{ width: 140 }}>
            <label className="input-label">Importance</label>
            <select className="select" value={importance} onChange={e => setImportance(e.target.value)}>
              <option value="must_know">🔴 Must-Know</option>
              <option value="standard">🟡 Standard</option>
              <option value="advanced">🟢 Advanced</option>
            </select>
          </div>
          <div className="input-group" style={{ width: 100 }}>
            <label className="input-label">Difficulty</label>
            <select className="select" value={difficulty} onChange={e => setDifficulty(parseInt(e.target.value))}>
              <option value={1}>Easy</option>
              <option value={2}>Medium</option>
              <option value={3}>Hard</option>
            </select>
          </div>
        </div>

        <div className="input-group" style={{ marginBottom: 12 }}>
          <label className="input-label">Question *</label>
          <input className="input" value={questionText} onChange={e => setQuestionText(e.target.value)} required
            placeholder="What is compound fracture? Classify it." />
        </div>

        <div className="input-group" style={{ marginBottom: 16 }}>
          <label className="input-label">Answer *</label>
          <textarea className="input" rows={5} value={answerText} onChange={e => setAnswerText(e.target.value)} required
            style={{ resize: "vertical" }}
            placeholder="A compound fracture (open fracture) is one where the fracture site communicates with the external environment through a wound in the skin..." />
        </div>

        <button className="btn btn-primary" type="submit">➕ Add Question</button>
      </form>
    </div>
  );
}
