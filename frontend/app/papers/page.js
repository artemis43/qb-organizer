"use client";
import { useState, useEffect, useRef } from "react";
import {
  uploadQP, uploadBatchQPs, getPapers, getQPQuestions, getSubjects,
  getTextbooks, runMatching, deletePaper, connectProgress,
  getAnswerForMapping, getMappings,
} from "@/lib/api";

export default function PapersPage() {
  const [papers, setPapers] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [textbooks, setTextbooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [showMatchModal, setShowMatchModal] = useState(false);
  const [matchProgress, setMatchProgress] = useState(null);
  const [expandedPaper, setExpandedPaper] = useState(null);
  const [paperQuestions, setPaperQuestions] = useState({});
  const [selectedPapers, setSelectedPapers] = useState([]);
  const [expandedQuestion, setExpandedQuestion] = useState(null);
  const [questionMappings, setQuestionMappings] = useState({});
  const [questionAnswers, setQuestionAnswers] = useState({});
  const [toast, setToast] = useState(null);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    try {
      setLoading(true);
      const [p, s, t] = await Promise.all([getPapers(), getSubjects(), getTextbooks()]);
      setPapers(p);
      setSubjects(s);
      setTextbooks(t);
    } catch (err) { showToast("Load failed: " + err.message, "error"); }
    finally { setLoading(false); }
  }

  function showToast(msg, type = "info") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  async function handleDelete(e, id, name) {
    e.stopPropagation();
    if (!confirm(`Delete "${name}" and all its questions and mappings?`)) return;
    try {
      await deletePaper(id);
      loadAll();
      showToast("Paper deleted", "success");
    } catch (err) { showToast("Delete failed: " + err.message, "error"); }
  }

  function togglePaperSelect(e, id) {
    e.stopPropagation();
    setSelectedPapers(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  function selectAllPapers() {
    if (selectedPapers.length === papers.length) setSelectedPapers([]);
    else setSelectedPapers(papers.map(p => p.id));
  }

  async function togglePaper(id) {
    if (expandedPaper === id) { setExpandedPaper(null); return; }
    setExpandedPaper(id);
    setExpandedQuestion(null);
    if (!paperQuestions[id]) {
      try {
        const qs = await getQPQuestions(id);
        setPaperQuestions(prev => ({ ...prev, [id]: qs }));

        // Load mappings for this paper's questions
        const mappingsData = await getMappings(null, null);
        const mappingMap = {};
        for (const m of mappingsData) {
          mappingMap[m.question_id] = m;
        }
        setQuestionMappings(prev => ({ ...prev, ...mappingMap }));
      } catch (err) { showToast("Failed to load questions", "error"); }
    }
  }

  async function toggleQuestion(qId, mappingId) {
    if (expandedQuestion === qId) { setExpandedQuestion(null); return; }
    setExpandedQuestion(qId);

    // Load answer if mapping exists and not already loaded
    if (mappingId && !questionAnswers[mappingId]) {
      try {
        const ans = await getAnswerForMapping(mappingId);
        if (ans && ans.id) {
          setQuestionAnswers(prev => ({ ...prev, [mappingId]: ans }));
        }
      } catch { /* no answer */ }
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">📝 Question Papers</h1>
          <p className="page-subtitle">Upload papers, extract questions, and run chapter matching</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {papers.length > 1 && (
            <button className="btn btn-sm btn-secondary" onClick={selectAllPapers}>
              {selectedPapers.length === papers.length ? "Deselect All" : "Select All"}
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => setShowMatchModal(true)}
            disabled={papers.length === 0 || textbooks.length === 0}>
            🔗 Run Matching{selectedPapers.length > 0 ? ` (${selectedPapers.length})` : ""}
          </button>
          <button className="btn btn-primary" onClick={() => setShowUpload(true)}>+ Upload Paper</button>
        </div>
      </div>

      {showUpload && (
        <UploadForm
          subjects={subjects}
          papers={papers}
          onClose={() => setShowUpload(false)}
          onSuccess={() => { setShowUpload(false); loadAll(); }}
          showToast={showToast}
        />
      )}

      {showMatchModal && (
        <MatchModal
          subjects={subjects}
          textbooks={textbooks}
          papers={papers}
          selectedPapers={selectedPapers}
          progress={matchProgress}
          onStart={(taskId) => {
            connectProgress(taskId, (data) => {
              setMatchProgress(data);
              if (data.step === "done") {
                try {
                  const res = JSON.parse(data.message);
                  setMatchProgress({ ...data, results: res });
                } catch { /* keep as-is */ }
              }
            }, (err) => setMatchProgress({ step: "error", message: err }));
          }}
          onClose={() => { setShowMatchModal(false); setMatchProgress(null); loadAll(); }}
          showToast={showToast}
        />
      )}

      {/* Inline match progress when modal is open */}
      {matchProgress && matchProgress.step !== "done" && matchProgress.step !== "error" && !showMatchModal && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div className="spinner" />
            <span style={{ fontSize: 13, color: "var(--text)" }}>Matching in progress...</span>
          </div>
          <div className="progress-bar-container"><div className="progress-bar-fill" style={{ width: `${matchProgress.percentage || 0}%` }} /></div>
          <div className="progress-text"><span>{matchProgress.message}</span><span>{(matchProgress.percentage || 0).toFixed(0)}%</span></div>
        </div>
      )}

      {loading ? (
        <div className="loading-overlay"><div className="spinner" /> Loading...</div>
      ) : papers.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📝</div>
          <div className="empty-state-title">No question papers yet</div>
          <div className="empty-state-text">Upload question paper PDFs to extract and match questions to chapters</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowUpload(true)}>Upload First Paper</button>
        </div>
      ) : (
        <div>
          {papers.map((qp, i) => (
            <div key={qp.id} className="animate-in" style={{ animationDelay: `${i * 0.04}s` }}>
              <div className="card" style={{
                marginBottom: expandedPaper === qp.id ? 0 : 10,
                cursor: "pointer",
                borderBottomLeftRadius: expandedPaper === qp.id ? 0 : undefined,
                borderBottomRightRadius: expandedPaper === qp.id ? 0 : undefined,
                borderLeft: selectedPapers.includes(qp.id) ? "3px solid var(--accent)" : undefined,
              }} onClick={() => togglePaper(qp.id)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {/* Selection checkbox */}
                    <div onClick={e => togglePaperSelect(e, qp.id)} style={{ cursor: "pointer" }}>
                      <div style={{
                        width: 18, height: 18, borderRadius: 4,
                        border: `2px solid ${selectedPapers.includes(qp.id) ? "var(--accent)" : "var(--border)"}`,
                        background: selectedPapers.includes(qp.id) ? "var(--accent)" : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 11, color: "#fff", transition: "all var(--t)",
                      }}>
                        {selectedPapers.includes(qp.id) && "✓"}
                      </div>
                    </div>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", transition: "transform var(--t)", transform: expandedPaper === qp.id ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-bright)" }}>{qp.name || qp.filename}</div>
                      <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2, fontFamily: "var(--mono)" }}>
                        {qp.subject} · {qp.university || "?"} · {qp.month || ""} {qp.year || ""} · {qp.total_questions || 0} questions
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`badge badge-${qp.status === "completed" ? "high" : qp.status === "failed" ? "low" : "medium"}`}>
                      {qp.status}
                    </span>
                    <button className="btn btn-sm" style={{ background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid rgba(248,113,113,0.3)" }} onClick={(e) => handleDelete(e, qp.id, qp.name || qp.filename)} title="Delete">🗑</button>
                  </div>
                </div>
              </div>

              {/* Expanded questions */}
              {expandedPaper === qp.id && (
                <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 var(--r) var(--r)", marginBottom: 10, overflow: "hidden" }}>
                  {!paperQuestions[qp.id] ? (
                    <div className="loading-overlay" style={{ padding: 20 }}><div className="spinner" /> Loading questions...</div>
                  ) : paperQuestions[qp.id].length === 0 ? (
                    <div style={{ padding: 16, fontSize: 13, color: "var(--text-dim)" }}>No questions extracted</div>
                  ) : (
                    <div>
                      {paperQuestions[qp.id].map((q, qi) => {
                        const mapping = questionMappings[q.id];
                        const mappingId = mapping?.id;
                        const answer = mappingId ? questionAnswers[mappingId] : null;
                        const isExpanded = expandedQuestion === q.id;

                        return (
                          <div key={q.id}>
                            <div style={{
                              padding: "8px 14px",
                              borderBottom: "1px solid var(--border)",
                              cursor: "pointer",
                              background: isExpanded ? "rgba(77,127,255,0.04)" : "transparent",
                              transition: "background var(--t)",
                            }}
                              onClick={() => toggleQuestion(q.id, mappingId)}>
                              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", minWidth: 32, paddingTop: 2 }}>Q{q.question_number}</span>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontSize: 13, color: "var(--text)" }}>{q.question_text}</div>
                                </div>
                                <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                                  {mapping && (
                                    <span className={`badge badge-${mapping.confidence_level}`} style={{ fontSize: 10 }}>
                                      {mapping.final_chapter_name?.substring(0, 20) || "—"}
                                    </span>
                                  )}
                                  {answer && (
                                    <span className="badge badge-high" style={{ fontSize: 10 }}>✍️</span>
                                  )}
                                  <span className="badge badge-info" style={{ flexShrink: 0 }}>{q.question_type}</span>
                                  <span style={{ fontSize: 10, color: "var(--text-dim)", transition: "transform var(--t)", transform: isExpanded ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
                                </div>
                              </div>
                            </div>

                            {/* Expanded question detail */}
                            {isExpanded && (
                              <div style={{
                                padding: "10px 14px 10px 56px",
                                borderBottom: "1px solid var(--border)",
                                background: "rgba(0,0,0,0.15)",
                              }}>
                                {mapping ? (
                                  <div>
                                    <div style={{ fontSize: 12, marginBottom: 8 }}>
                                      <span style={{ color: "var(--text-dim)" }}>Chapter: </span>
                                      <span style={{ color: "var(--text-bright)", fontWeight: 600 }}>{mapping.final_chapter_name}</span>
                                      <span style={{ color: "var(--text-dim)", fontFamily: "var(--mono)", marginLeft: 8 }}>
                                        {((mapping.confidence || 0) * 100).toFixed(0)}% · {mapping.confidence_level}
                                      </span>
                                    </div>
                                    {mapping.best_match?.reasoning && (
                                      <div style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic", marginBottom: 8 }}>
                                        {mapping.best_match.reasoning}
                                      </div>
                                    )}
                                    {mapping.best_match?.page_references && Object.keys(mapping.best_match.page_references).length > 0 && (
                                      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8, fontFamily: "var(--mono)" }}>
                                        📖 Pages: {Object.entries(mapping.best_match.page_references).map(([k, v]) => `${k}: ${v}`).join(", ")}
                                      </div>
                                    )}

                                    {/* Answer display */}
                                    {answer ? (
                                      <div style={{
                                        marginTop: 8, padding: 10,
                                        background: "rgba(77,127,255,0.05)",
                                        border: "1px solid rgba(77,127,255,0.15)",
                                        borderRadius: 6,
                                      }}>
                                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", marginBottom: 6 }}>
                                          ✍️ Answer ({answer.preset} · {answer.bullet_count} bullets)
                                        </div>
                                        {answer.prologue && (
                                          <div style={{ fontSize: 12, fontStyle: "italic", color: "var(--text)", marginBottom: 6, lineHeight: 1.5, borderLeft: "2px solid var(--accent)", paddingLeft: 8 }}>
                                            {answer.prologue}
                                          </div>
                                        )}
                                        {(answer.bullets || []).map((b, bi) => (
                                          <div key={bi} style={{ display: "flex", gap: 6, margin: "3px 0", fontSize: 12 }}>
                                            <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", minWidth: 18, fontWeight: 700 }}>{bi + 1}.</span>
                                            <span style={{ color: "var(--text)", lineHeight: 1.4 }}>{b}</span>
                                          </div>
                                        ))}
                                        {answer.epilogue && (
                                          <div style={{ fontSize: 12, fontStyle: "italic", color: "var(--text)", marginTop: 6, lineHeight: 1.5, borderLeft: "2px solid var(--success)", paddingLeft: 8 }}>
                                            {answer.epilogue}
                                          </div>
                                        )}
                                        {/* Images */}
                                        {answer.images && answer.images.length > 0 && (
                                          <div style={{ marginTop: 8 }}>
                                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>📸 Reference Images</div>
                                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                              {answer.images.map((img, ii) => (
                                                <div key={ii} style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden", maxWidth: 180 }}>
                                                  <img
                                                    src={`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/images/${img.filename?.split("_p")[0] || "unknown"}/${img.filename}`}
                                                    alt={img.caption || `Page ${img.page}`}
                                                    style={{ maxWidth: "100%", maxHeight: 140, objectFit: "contain", display: "block" }}
                                                    onError={e => { e.target.style.display = "none"; }}
                                                  />
                                                  <div style={{ padding: "3px 5px", fontSize: 9, color: "var(--text-dim)", background: "var(--bg)" }}>
                                                    p.{img.page}{img.caption ? ` — ${img.caption.substring(0, 60)}` : ""}
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>No answer generated yet</div>
                                    )}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Not matched yet — run matching first</div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

function UploadForm({ subjects, papers, onClose, onSuccess, showToast }) {
  const [file, setFile] = useState(null);
  const [subject, setSubject] = useState("");
  const [customSubject, setCustomSubject] = useState("");
  const [selectedUni, setSelectedUni] = useState("");
  const [customUni, setCustomUni] = useState("");
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [selectedSchemas, setSelectedSchemas] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const effectiveSubject = subject === "__custom__" ? customSubject : subject;
  const effectiveUni = selectedUni === "__custom__" ? customUni : selectedUni;

  const existingUnis = Array.from(new Set(papers.map(p => p.university).filter(Boolean)));
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const years = Array.from({ length: 11 }, (_, i) => 2020 + i);
  const SCHEMAS = ["RS-1", "RS-2", "RS-3", "RS-4", "RS-5", "RS-6", "RS-7", "RS-8"];

  function handleDrop(e) {
    e.preventDefault(); setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type === "application/pdf") setFile(dropped);
  }

  function toggleSchema(sch) {
    setSelectedSchemas(prev =>
      prev.includes(sch) ? prev.filter(x => x !== sch) : [...prev, sch]
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file || !effectiveSubject) return;
    setUploading(true);
    try {
      const metadata = {
        university: effectiveUni,
        year: year ? parseInt(year) : undefined,
        month,
        schema: selectedSchemas.join(", "),
      };
      const result = await uploadQP(file, effectiveSubject, metadata);
      if (result.task_id) {
        connectProgress(result.task_id, (data) => {
          setProgress(data);
          if (data.step === "done") { showToast("Paper uploaded & questions extracted", "success"); setTimeout(onSuccess, 1000); }
          if (data.step === "error") { showToast("Error: " + data.message, "error"); setUploading(false); }
        });
      } else { showToast(`Uploaded: ${result.total_questions || 0} questions extracted`, "success"); onSuccess(); }
    } catch (err) { showToast("Upload failed: " + err.message, "error"); setUploading(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !uploading && onClose()}>
      <div className="modal-box" style={{ maxWidth: 560 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>📝 Upload Question Paper</h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={uploading}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className={`file-upload-zone ${dragOver ? "drag-over" : ""}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
            onClick={() => !uploading && fileRef.current.click()} style={{ marginBottom: 14 }}>
            <input ref={fileRef} type="file" accept=".pdf" style={{ display: "none" }} disabled={uploading}
              onChange={e => { if (e.target.files[0]) setFile(e.target.files[0]); }} />
            {file ? (
              <><div className="file-upload-icon">✅</div><div className="file-upload-text">{file.name}</div><div className="file-upload-hint">{(file.size/1024/1024).toFixed(1)} MB</div></>
            ) : (
              <><div className="file-upload-icon">📝</div><div className="file-upload-text">Drop a question paper PDF here</div><div className="file-upload-hint">PDF format — will auto-extract questions</div></>
            )}
          </div>

          <div className="grid-2" style={{ marginBottom: 4 }}>
            <div className="input-group">
              <label className="input-label">Subject</label>
              {subjects.length > 0 ? (
                <select className="select" value={subject} onChange={e => setSubject(e.target.value)} required disabled={uploading}>
                  <option value="">Select subject...</option>
                  {subjects.map(s => (
                    <option key={s.subject} value={s.subject}>{s.subject} ({s.textbook_count} textbook{s.textbook_count !== 1 ? "s" : ""})</option>
                  ))}
                  <option value="__custom__">+ Add new subject...</option>
                </select>
              ) : (
                <input className="input" value={customSubject} onChange={e => setCustomSubject(e.target.value)} placeholder="e.g. Orthopaedics" required disabled={uploading} />
              )}
              {subject === "__custom__" && (
                <input className="input" value={customSubject} onChange={e => setCustomSubject(e.target.value)} placeholder="Enter new subject name" style={{ marginTop: 6 }} required disabled={uploading} />
              )}
            </div>
            <div className="input-group">
              <label className="input-label">University</label>
              <select className="select" value={selectedUni} onChange={e => setSelectedUni(e.target.value)} disabled={uploading}>
                <option value="">Select university...</option>
                {existingUnis.map(u => (
                  <option key={u} value={u}>{u}</option>
                ))}
                <option value="__custom__">+ Add new university...</option>
              </select>
              {(selectedUni === "__custom__" || existingUnis.length === 0) && (
                <input className="input" value={customUni} onChange={e => setCustomUni(e.target.value)} placeholder="Enter university (e.g. RGUHS)" style={{ marginTop: 6 }} required disabled={uploading} />
              )}
            </div>
          </div>
          <div className="grid-2">
            <div className="input-group">
              <label className="input-label">Year</label>
              <select className="select" value={year} onChange={e => setYear(e.target.value)} disabled={uploading}>
                <option value="">Select year...</option>
                {years.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div className="input-group">
              <label className="input-label">Month</label>
              <select className="select" value={month} onChange={e => setMonth(e.target.value)} disabled={uploading}>
                <option value="">Select month...</option>
                {months.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="input-group" style={{ marginTop: 8, marginBottom: 14 }}>
            <label className="input-label">Schema</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {SCHEMAS.map(sch => {
                const isSelected = selectedSchemas.includes(sch);
                return (
                  <button
                    key={sch}
                    type="button"
                    className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => toggleSchema(sch)}
                    disabled={uploading}
                    style={{
                      borderRadius: 16,
                      padding: "4px 12px",
                      fontSize: 12,
                      border: isSelected ? "none" : "1px solid var(--border)",
                      background: isSelected ? "var(--accent)" : "transparent",
                      color: isSelected ? "#fff" : "var(--text-dim)",
                    }}
                  >
                    {sch}
                  </button>
                );
              })}
            </div>
          </div>

          {progress && (
            <div style={{ marginBottom: 14 }}>
              <div className="progress-bar-container"><div className="progress-bar-fill" style={{ width: `${progress.percentage || 0}%` }} /></div>
              <div className="progress-text"><span>{progress.message}</span><span>{(progress.percentage||0).toFixed(0)}%</span></div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn btn-secondary" type="button" onClick={onClose} disabled={uploading}>Cancel</button>
            <button className="btn btn-primary" type="submit" disabled={uploading || !file || !effectiveSubject}>
              {uploading ? "Uploading & Extracting..." : "Upload & Extract Questions"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MatchModal({ subjects, textbooks, papers, selectedPapers, progress, onStart, onClose, showToast }) {
  const [subject, setSubject] = useState("");
  const [textbookId, setTextbookId] = useState("");
  const [running, setRunning] = useState(false);
  const [localSelected, setLocalSelected] = useState(selectedPapers || []);

  const availableTextbooks = textbooks.filter(tb => !subject || tb.subject === subject);
  const subjectPapers = papers.filter(p => !subject || p.subject === subject);

  function toggleLocal(id) {
    setLocalSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function handleMatch() {
    if (!subject || !textbookId) { showToast("Select subject and textbook", "error"); return; }
    setRunning(true);
    try {
      const paperIds = localSelected.length > 0 ? localSelected : null;
      const res = await runMatching(subject, textbookId, paperIds);
      if (res.task_id) onStart(res.task_id);
      else showToast("Matching returned no task ID", "error");
    } catch (err) { showToast("Match failed: " + err.message, "error"); setRunning(false); }
  }

  const isDone = progress?.step === "done";
  const isError = progress?.step === "error";
  const results = progress?.results;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="modal-box" style={{ maxWidth: 520 }}>
        <h3>🔗 Run Chapter Matching</h3>

        {!running && !progress && (
          <>
            <div className="input-group">
              <label className="input-label">Subject</label>
              <select className="select" value={subject} onChange={e => { setSubject(e.target.value); setTextbookId(""); }}>
                <option value="">Select subject...</option>
                {subjects.map(s => <option key={s.subject} value={s.subject}>{s.subject}</option>)}
              </select>
            </div>
            <div className="input-group">
              <label className="input-label">Target Textbook</label>
              <select className="select" value={textbookId} onChange={e => setTextbookId(e.target.value)} disabled={!subject}>
                <option value="">Select textbook...</option>
                {availableTextbooks.map(tb => (
                  <option key={tb.id} value={tb.id}>{tb.name} ({tb.total_chapters} chapters)</option>
                ))}
              </select>
            </div>

            {/* Paper selection */}
            {subject && subjectPapers.length > 0 && (
              <div className="input-group">
                <label className="input-label">Papers to Match (leave empty for all)</label>
                <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--r)", padding: 6 }}>
                  {subjectPapers.map(p => (
                    <div key={p.id} style={{
                      display: "flex", gap: 8, alignItems: "center",
                      padding: "5px 6px", cursor: "pointer", borderRadius: 4,
                      background: localSelected.includes(p.id) ? "rgba(77,127,255,0.08)" : "transparent",
                    }} onClick={() => toggleLocal(p.id)}>
                      <div style={{
                        width: 16, height: 16, borderRadius: 3,
                        border: `2px solid ${localSelected.includes(p.id) ? "var(--accent)" : "var(--border)"}`,
                        background: localSelected.includes(p.id) ? "var(--accent)" : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, color: "#fff",
                      }}>{localSelected.includes(p.id) && "✓"}</div>
                      <span style={{ fontSize: 12, color: "var(--text)" }}>{p.name || p.filename}</span>
                      <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>{p.total_questions || 0}q</span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                  {localSelected.length > 0 ? `${localSelected.length} paper(s) selected` : "All papers will be matched"}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={handleMatch} disabled={!subject || !textbookId}>Start Matching</button>
            </div>
          </>
        )}

        {(running || progress) && !isDone && !isError && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <div className="spinner" />
              <span style={{ fontSize: 13, color: "var(--text)" }}>Matching in progress...</span>
            </div>
            {progress && (
              <>
                <div className="progress-bar-container" style={{ marginBottom: 8 }}>
                  <div className="progress-bar-fill" style={{ width: `${progress.percentage || 0}%` }} />
                </div>
                <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 4 }}>{progress.message}</div>
                <div className="progress-text">
                  <span>Step: {progress.step}</span>
                  <span>{progress.current || 0}/{progress.total || 0}</span>
                </div>
              </>
            )}
          </div>
        )}

        {isDone && (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--success)", marginBottom: 14 }}>✓ Matching Complete!</div>
            {results && (
              <div>
                <div className="grid-3" style={{ marginBottom: 12 }}>
                  <div className="stat-card"><div className="stat-value" style={{ color: "var(--success)" }}>{results.high || 0}</div><div className="stat-label">HIGH (auto-accepted)</div></div>
                  <div className="stat-card"><div className="stat-value" style={{ color: "var(--warning)" }}>{results.medium || 0}</div><div className="stat-label">MEDIUM (needs review)</div></div>
                  <div className="stat-card"><div className="stat-value" style={{ color: "var(--danger)" }}>{results.low || 0}</div><div className="stat-label">LOW (needs review)</div></div>
                </div>
                {results.answer_copied > 0 && (
                  <div style={{ fontSize: 13, color: "var(--accent)", marginBottom: 12, fontFamily: "var(--mono)" }}>
                    ✍️ {results.answer_copied} answer(s) automatically copied from similar questions
                  </div>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={onClose}>Close</button>
              <a href="/review" className="btn btn-primary">Go to Review Center →</a>
            </div>
          </div>
        )}

        {isError && (
          <div>
            <div style={{ fontSize: 14, color: "var(--danger)", marginBottom: 12 }}>❌ Matching Failed</div>
            <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 16 }}>{progress.message}</div>
            <button className="btn btn-secondary" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
