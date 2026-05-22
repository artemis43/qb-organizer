"use client";
import { useState, useEffect, useRef } from "react";
import { qbPushToFirestore, getQbFirestoreStatus, getQbPushStats, getTextbooks, getChapters, getMappings } from "@/lib/api";

const API_BASE = "http://localhost:8000/api";

const PUSH_STEPS = [
  { label: "Loading Data", desc: "Loading mappings & chapters" },
  { label: "Deduplicating", desc: "Finding duplicate questions" },
  { label: "Creating Hierarchy", desc: "Setting up Firestore structure" },
  { label: "Pushing Content", desc: "Uploading images & questions" },
  { label: "Complete", desc: "Export finished successfully" }
];

export default function DeployPage() {
  const [textbooks, setTextbooks] = useState([]);
  const [pushStats, setPushStats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fsConnected, setFsConnected] = useState(null);
  
  // Selection & filtering states
  const [selectedSubject, setSelectedSubject] = useState("");
  const [chapters, setChapters] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [selectedChapters, setSelectedChapters] = useState(new Set());
  const [qTypeFilter, setQTypeFilter] = useState("ALL");
  const [answeredOnly, setAnsweredOnly] = useState(false);
  
  // Push options
  const [uploadImages, setUploadImages] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  
  // Pipeline status tracking states
  const [pushing, setPushing] = useState(false);
  const [progressData, setProgressData] = useState(null);
  const [pushResult, setPushResult] = useState(null);
  const [pushError, setPushError] = useState(null);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    Promise.all([
      getTextbooks(),
      getQbPushStats().catch(() => ({ subjects: [] })),
      getQbFirestoreStatus().catch(() => ({ connected: false })),
    ]).then(([tbs, stats, fs]) => {
      setTextbooks(tbs);
      setPushStats(stats.subjects || []);
      setFsConnected(fs.connected);
      setLoading(false);
    });
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, []);

  // Fetch chapters & mappings when subject is selected
  useEffect(() => {
    if (selectedSubject) {
      setChapters([]);
      setMappings([]);
      setSelectedChapters(new Set());
      
      Promise.all([
        getChapters(selectedSubject).catch(() => []),
        getMappings(selectedSubject).catch(() => []),
      ]).then(([chaps, maps]) => {
        setChapters(chaps);
        setMappings(maps);
        // Pre-select all chapters initially
        setSelectedChapters(new Set(chaps.map(c => c.id)));
      });
    } else {
      setChapters([]);
      setMappings([]);
      setSelectedChapters(new Set());
    }
  }, [selectedSubject]);

  const subjects = [...new Set(textbooks.map(t => t.subject))];
  const subjectStats = pushStats.find(s => s.subject === selectedSubject) || {};

  // Compute pushable and filtered questions
  const pushableMappings = mappings.filter(m => m.is_reviewed || m.confidence_level === "high");
  
  const eligibleMappings = pushableMappings.filter(m => {
    const chId = m.final_chapter_id || (m.best_match && m.best_match.chapter_id) || "";
    // Filter by selected chapters
    if (!selectedChapters.has(chId)) return false;
    // Filter by type
    if (qTypeFilter !== "ALL" && m.question_type !== qTypeFilter) return false;
    // Filter by answered status
    if (answeredOnly && !m.has_answer) return false;
    return true;
  });

  const getChapterStats = (chapId) => {
    const chapMappings = pushableMappings.filter(m => {
      const cid = m.final_chapter_id || (m.best_match && m.best_match.chapter_id) || "";
      return cid === chapId;
    });
    const total = chapMappings.length;
    const answered = chapMappings.filter(m => m.has_answer).length;
    return { total, answered };
  };

  async function handlePush() {
    if (!selectedSubject || eligibleMappings.length === 0) return;
    setPushing(true);
    setProgressData(null);
    setPushResult(null);
    setPushError(null);

    try {
      const mappingIds = eligibleMappings.map(m => m.id);
      const result = await qbPushToFirestore(selectedSubject, mappingIds, uploadImages, dryRun);
      const taskId = result.task_id;

      // Listen for SSE progress
      const es = new EventSource(`${API_BASE}/progress/${taskId}`);
      eventSourceRef.current = es;

      es.addEventListener("progress", (event) => {
        const data = JSON.parse(event.data);
        setProgressData(data);

        if (data.step === "done") {
          try { setPushResult(JSON.parse(data.message)); } catch { setPushResult({}); }
          setPushing(false);
          es.close();
          // Refresh statistics
          getQbPushStats().then(s => setPushStats(s.subjects || [])).catch(() => {});
        } else if (data.step === "error") {
          setPushError(data.message);
          setPushing(false);
          es.close();
        }
      });

      es.onerror = () => {
        setPushing(false);
        es.close();
      };
    } catch (err) {
      alert("Push execution failed: " + err.message);
      setPushing(false);
    }
  }

  const toggleChapter = (chapterId) => {
    const next = new Set(selectedChapters);
    if (next.has(chapterId)) {
      next.delete(chapterId);
    } else {
      next.add(chapterId);
    }
    setSelectedChapters(next);
  };

  const getStepStatus = (index) => {
    if (pushError) {
      if (progressData && progressData.current === index) return "error";
      if (progressData && progressData.current > index) return "completed";
      return "pending";
    }
    if (pushResult) return "completed";
    if (progressData) {
      if (progressData.current > index) return "completed";
      if (progressData.current === index) return "active";
    }
    return "pending";
  };

  // Stepper progress line width
  const getLineActiveWidth = () => {
    if (pushResult) return "100%";
    if (!progressData) return "0%";
    const current = progressData.current || 0;
    const totalSteps = PUSH_STEPS.length - 1;
    return `${(current / totalSteps) * 100}%`;
  };

  return (
    <div className="animate-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">🚀 Deploy to Firestore</h1>
          <p className="page-subtitle">Push reviewed question banks and generated answers to the production Firestore database</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 10, height: 10, borderRadius: "50%",
            background: fsConnected === true ? "var(--success)" : fsConnected === false ? "var(--danger)" : "var(--text-dim)"
          }} />
          <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {fsConnected === true ? "Firestore Connected" : fsConnected === false ? "Firestore Disconnected" : "Checking..."}
          </span>
        </div>
      </div>

      {/* Subject Stats Overview */}
      {pushStats.length > 0 && (
        <div className="grid-4" style={{ marginBottom: 24 }}>
          {pushStats.map(s => (
            <div key={s.subject} className="stat-card" onClick={() => setSelectedSubject(s.subject)} style={{ cursor: "pointer", border: selectedSubject === s.subject ? "2px solid var(--accent)" : undefined }}>
              <div className="stat-icon">📚</div>
              <div className="stat-value" style={{ fontSize: 16 }}>{s.subject}</div>
              <div className="stat-label">
                {s.pushable_questions} pushable / {s.total_questions} total
                {s.answered_questions > 0 && ` · ${s.answered_questions} answered`}
                {s.answers_with_images > 0 && ` · ${s.answers_with_images} with images`}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Main Panel grid */}
      <div style={{ display: "grid", gridTemplateColumns: selectedSubject ? "1fr 1fr" : "1fr", gap: 24, marginBottom: 24 }}>
        
        {/* Left Panel: Settings and Trigger */}
        <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div className="card-title" style={{ marginBottom: 16 }}>Push Settings</div>
            
            <div className="input-group" style={{ marginBottom: 16 }}>
              <label className="input-label">Subject</label>
              <select className="select" value={selectedSubject} onChange={(e) => setSelectedSubject(e.target.value)}>
                <option value="">Select subject...</option>
                {subjects.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {selectedSubject && (
              <>
                <div className="input-group" style={{ marginBottom: 16 }}>
                  <label className="input-label">Deployment Modes</label>
                  
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13, padding: "8px 0" }}>
                    <input
                      type="checkbox"
                      checked={uploadImages}
                      onChange={(e) => setUploadImages(e.target.checked)}
                      style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
                    />
                    <span>Upload answer illustrations/images to ImageKit</span>
                  </label>

                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13, padding: "8px 0", color: dryRun ? "var(--warning)" : "var(--text)" }}>
                    <input
                      type="checkbox"
                      checked={dryRun}
                      onChange={(e) => setDryRun(e.target.checked)}
                      style={{ width: 16, height: 16, accentColor: "var(--warning)" }}
                    />
                    <span><strong>Dry-run simulation mode</strong> (validate pipeline without writing)</span>
                  </label>
                </div>

                <div style={{ padding: 12, background: "var(--surface)", borderRadius: 8, fontSize: 13, border: "1px solid var(--border)", marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, color: "var(--text-bright)", marginBottom: 6 }}>Deployment Summary:</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--text-dim)" }}>
                    <span>📦 Subject: <strong>{selectedSubject}</strong></span>
                    <span>📝 Pushable Questions: <strong>{pushableMappings.length}</strong></span>
                    <span>🎯 Selected to Push: <strong style={{ color: "var(--accent)" }}>{eligibleMappings.length}</strong></span>
                    <span>🖼️ Images in Selection: <strong>{eligibleMappings.filter(m => m.has_answer && m.appears_in_exams).length /* approx */}</strong></span>
                  </div>
                </div>
              </>
            )}
          </div>

          <div>
            <button
              className={`btn ${dryRun ? "btn-secondary" : "btn-primary"}`}
              onClick={handlePush}
              disabled={!selectedSubject || pushing || !fsConnected || eligibleMappings.length === 0}
              style={{ width: "100%", padding: "12px", border: dryRun ? "1px solid var(--warning)" : undefined }}
            >
              {pushing ? "⏳ Executing..." : dryRun ? "🔍 Simulate Push (Dry-Run)" : "🚀 Push to Firestore"}
            </button>
            {selectedSubject && eligibleMappings.length === 0 && (
              <p style={{ color: "var(--danger)", fontSize: 12, textAlign: "center", marginTop: 8 }}>
                No questions selected. Adjust your filters or checklist.
              </p>
            )}
          </div>
        </div>

        {/* Right Panel: Granular Checkbox Checklist */}
        {selectedSubject && (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Granular Selection</div>
            
            {/* Filters Row */}
            <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
              <div className="input-group" style={{ flex: 1, minWidth: 140 }}>
                <label className="input-label" style={{ fontSize: 11 }}>Question Type</label>
                <select className="select" style={{ height: 32, padding: "0 8px", fontSize: 12 }} value={qTypeFilter} onChange={(e) => setQTypeFilter(e.target.value)}>
                  <option value="ALL">All Types</option>
                  <option value="LAQ">LAQs (Long)</option>
                  <option value="SAQ">SAQs (Short)</option>
                  <option value="VSAQ">VSAQs (Very Short)</option>
                  <option value="OTHER">Other / Uncategorized</option>
                </select>
              </div>

              <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 6 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={answeredOnly}
                    onChange={(e) => setAnsweredOnly(e.target.checked)}
                    style={{ width: 14, height: 14, accentColor: "var(--accent)" }}
                  />
                  <span>Answered only ({pushableMappings.filter(m => m.has_answer).length})</span>
                </label>
              </div>
            </div>

            {/* Select controls */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Select Chapters to Include:</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" style={{ fontSize: 10, padding: "2px 6px", height: "auto" }} onClick={() => setSelectedChapters(new Set(chapters.map(c => c.id)))}>Select All</button>
                <button className="btn" style={{ fontSize: 10, padding: "2px 6px", height: "auto" }} onClick={() => setSelectedChapters(new Set())}>Clear</button>
              </div>
            </div>

            {/* Checklist */}
            <div className="checklist-container">
              {chapters.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
                  No chapters found.
                </div>
              ) : (
                chapters.map(ch => {
                  const stats = getChapterStats(ch.id);
                  const isChecked = selectedChapters.has(ch.id);
                  return (
                    <div key={ch.id} className="checklist-item" onClick={() => toggleChapter(ch.id)}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        readOnly
                        style={{ pointerEvents: "none", width: 14, height: 14, accentColor: "var(--accent)" }}
                      />
                      <div style={{ flexGrow: 1 }}>
                        <div style={{ fontWeight: 500, color: isChecked ? "var(--text-bright)" : "var(--text)" }}>
                          Ch {ch.chapter_number}: {ch.name}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                          {stats.total} pushable questions · {stats.answered} answered
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* Progress & Stepper Panel */}
      {(progressData || pushResult || pushError) && (
        <div className="card animate-in" style={{ marginBottom: 24 }}>
          <div className="card-title" style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>
              {dryRun ? "🔍 Dry-Run Simulation Status" : "⏳ Production Push Status"}
            </span>
            <span style={{ fontSize: 12, color: pushResult ? "var(--success)" : pushError ? "var(--danger)" : "var(--accent)" }}>
              {pushResult ? "Completed" : pushError ? "Failed" : "Processing"}
            </span>
          </div>

          {/* Stepper Visual Nodes */}
          <div className="stepper-container">
            <div className="stepper-line-bg" />
            <div className="stepper-line-active" style={{ width: getLineActiveWidth() }} />
            
            {PUSH_STEPS.map((step, idx) => {
              const status = getStepStatus(idx);
              return (
                <div key={idx} className={`stepper-step ${status}`}>
                  <div className="stepper-node">
                    {status === "completed" ? "✓" : status === "error" ? "!" : idx + 1}
                  </div>
                  <div className="stepper-label">
                    <div>{idx === 4 && dryRun ? "Dry-Run Done" : step.label}</div>
                    <div style={{ fontSize: 9, opacity: 0.6, marginTop: 2 }}>{idx === 4 && dryRun ? "Simulation ready" : step.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Detailed logs/progress message */}
          {progressData && !pushResult && !pushError && (
            <div style={{ marginTop: 24 }}>
              <div style={{
                padding: 12, background: "var(--surface)", borderRadius: 8,
                fontSize: 13, fontFamily: "var(--mono)", border: "1px solid var(--border)",
                display: "flex", justifyContent: "space-between", alignItems: "center"
              }}>
                <span>🛰️ {progressData.message}</span>
                {progressData.total > 0 && (
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    Step {progressData.current} of {progressData.total}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Final push stats or dry-run stats */}
          {pushResult && (
            <div style={{ marginTop: 24, padding: 16, background: "rgba(16, 185, 129, 0.05)", border: "1px solid var(--success)", borderRadius: 8 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--success)", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                {dryRun ? "🔍 Dry-Run Simulation Finished" : "✅ Production Deployment Succeeded"}
              </h3>
              
              <div className="grid-4">
                <div className="stat-card" style={{ background: "var(--card)" }}>
                  <div className="stat-icon">📝</div>
                  <div className="stat-value">{pushResult.questions || 0}</div>
                  <div className="stat-label">Questions {dryRun ? "Validated" : "Pushed"}</div>
                </div>
                <div className="stat-card" style={{ background: "var(--card)" }}>
                  <div className="stat-icon">📖</div>
                  <div className="stat-value">{pushResult.answers || 0}</div>
                  <div className="stat-label">Answers {dryRun ? "Validated" : "Pushed"}</div>
                </div>
                <div className="stat-card" style={{ background: "var(--card)" }}>
                  <div className="stat-icon">🖼️</div>
                  <div className="stat-value">{pushResult.images_uploaded || 0}</div>
                  <div className="stat-label">Images {dryRun ? "Simulated" : "Uploaded"}</div>
                </div>
                <div className="stat-card" style={{ background: "var(--card)" }}>
                  <div className="stat-icon">🔄</div>
                  <div className="stat-value">{pushResult.duplicates_merged || 0}</div>
                  <div className="stat-label">Exam Tags Merged</div>
                </div>
              </div>
              
              {dryRun && (
                <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 14, fontStyle: "italic", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                  Note: This was a dry-run simulation. No records were written to Firestore, and no local mappings were modified.
                </p>
              )}
            </div>
          )}

          {pushError && (
            <div style={{
              marginTop: 24, padding: 12, background: "rgba(239, 68, 68, 0.05)",
              border: "1px solid var(--danger)", borderRadius: 8, color: "var(--danger)",
              fontSize: 13, fontWeight: 500
            }}>
              ⚠️ Pipeline Failed: {pushError}
            </div>
          )}
        </div>
      )}

      {/* Info Card */}
      <div className="card" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.6 }}>
          <strong>Firebase & Firestore Deployment Pipeline:</strong>
          <ul style={{ marginTop: 8, paddingLeft: 20 }}>
            <li>Select specific chapters to narrow down the target upload.</li>
            <li>Filter by question type (LAQs, SAQs, etc.) to batch-push certain categories.</li>
            <li>Use the dry-run simulation checkbox to verify question duplicates, ImageKit assets, and overall database mapping integrity before writing live records.</li>
            <li>Once uploaded, exam occurrences are auto-merged into arrays for seamless student exam review in the MBBS Companion client app.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
