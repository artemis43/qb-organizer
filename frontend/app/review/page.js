"use client";
import { useState, useEffect, useRef } from "react";
import { getMappings, reviewMapping, getChapters, deleteMapping } from "@/lib/api";

export default function ReviewPage() {
  const [mappings, setMappings] = useState([]);
  const [allChapters, setAllChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("needs_review");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [undoStack, setUndoStack] = useState([]);
  const [showMilestone, setShowMilestone] = useState(null);
  const [reviewCountThisSession, setReviewCountThisSession] = useState(0);

  // Load mappings and chapters
  useEffect(() => {
    load();
  }, [filter]);

  async function load() {
    setLoading(true);
    try {
      const confLevel = filter === "needs_review" ? null : filter === "all" ? null : filter;
      const [m, ch] = await Promise.all([getMappings(null, confLevel), getChapters()]);

      let filtered = m;
      if (filter === "needs_review") {
        filtered = m.filter(x => !x.is_reviewed);
      } else if (filter === "reviewed") {
        filtered = m.filter(x => x.is_reviewed);
      }

      setMappings(filtered);
      setAllChapters(ch);
      setCurrentIndex(0);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  // Handle a single review action
  async function handleReview(mappingId, action, chapterIds = null) {
    try {
      // Save for Undo before modification
      setUndoStack(prev => [
        ...prev,
        {
          mappings: JSON.parse(JSON.stringify(mappings)),
          currentIndex,
          reviewCountThisSession
        }
      ]);

      await reviewMapping(mappingId, action, chapterIds);

      // Perform in-place update of local state
      setMappings(prev => {
        if (filter === "needs_review") {
          const nextMappings = prev.filter(m => m.id !== mappingId);
          // If we removed the item, adjust current index if it falls out of range
          return nextMappings;
        } else {
          // If viewing all, just update its status
          return prev.map(m =>
            m.id === mappingId
              ? {
                  ...m,
                  is_reviewed: true,
                  reviewer_action: action,
                  final_chapter_name: Array.isArray(chapterIds)
                    ? allChapters.filter(c => chapterIds.includes(c.id)).map(c => c.name).join(", ")
                    : allChapters.find(c => c.id === chapterIds)?.name
                }
              : m
          );
        }
      });

      // Handle index clamping for needs_review
      if (filter === "needs_review") {
        setCurrentIndex(prev => {
          const nextLen = mappings.length - 1;
          if (nextLen <= 0) return 0;
          return Math.min(prev, nextLen - 1);
        });
      }

      const nextCount = reviewCountThisSession + 1;
      setReviewCountThisSession(nextCount);

      // Trigger milestone celebration every 5 reviews
      if (nextCount % 5 === 0) {
        setShowMilestone(nextCount);
        setTimeout(() => setShowMilestone(null), 3000);
      }

    } catch (err) {
      alert("Review failed: " + err.message);
    }
  }

  // Undo the last action
  function handleUndo() {
    if (undoStack.length === 0) return;
    const lastState = undoStack[undoStack.length - 1];
    setUndoStack(prev => prev.slice(0, -1));
    setMappings(lastState.mappings);
    setCurrentIndex(lastState.currentIndex);
    setReviewCountThisSession(lastState.reviewCountThisSession);
  }

  // Bulk accept all high-confidence mappings currently listed
  async function handleBulkAcceptHigh() {
    const highConf = mappings.filter(m => m.confidence_level === "high" && !m.is_reviewed);
    if (highConf.length === 0) {
      alert("No pending high-confidence mappings found in the current list.");
      return;
    }
    if (!confirm(`Are you sure you want to bulk accept all ${highConf.length} high-confidence mappings?`)) {
      return;
    }
    setLoading(true);
    try {
      // Process sequentially to be safe and avoid rate limits
      for (const m of highConf) {
        await reviewMapping(m.id, "accepted");
      }
      await load();
      alert(`Successfully accepted all ${highConf.length} mappings!`);
    } catch (err) {
      alert("Bulk accept failed: " + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(mappingId) {
    if (!confirm("Delete this mapping?")) return;
    try {
      await deleteMapping(mappingId);
      setMappings(prev => prev.filter(m => m.id !== mappingId));
      if (currentIndex >= mappings.length - 1) {
        setCurrentIndex(prev => Math.max(0, prev - 1));
      }
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }

  const handleNext = () => setCurrentIndex(prev => Math.min(prev + 1, mappings.length - 1));
  const handlePrev = () => setCurrentIndex(prev => Math.max(prev - 1, 0));

  const totalAll = mappings.length;
  const reviewedCount = mappings.filter(m => m.is_reviewed).length;
  const unreviewedMappings = mappings.filter(m => !m.is_reviewed);
  const current = mappings[currentIndex];

  // Trigger chapter picker toggle in card component via ref or custom event if needed
  const togglePickerRef = useRef(null);

  // Keyboard Shortcuts Hook
  useEffect(() => {
    function handleKeyDown(e) {
      if (
        document.activeElement.tagName === "INPUT" ||
        document.activeElement.tagName === "SELECT" ||
        document.activeElement.tagName === "TEXTAREA"
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        if (current && !current.is_reviewed) {
          handleReview(current.id, "accepted");
        }
      } else if (key === "s") {
        e.preventDefault();
        handleNext();
      } else if (key === "r") {
        e.preventDefault();
        if (togglePickerRef.current) {
          togglePickerRef.current();
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handleNext();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mappings, currentIndex, current]);

  return (
    <div>
      {/* Milestone Toast */}
      {showMilestone && (
        <div className="milestone-toast">
          <div className="milestone-icon">🔥</div>
          <div>
            <div style={{ fontWeight: 700 }}>Milestone Reached!</div>
            <div style={{ fontSize: 12 }}>You reviewed {showMilestone} questions in this session. Keep it up!</div>
          </div>
        </div>
      )}

      <div className="page-header">
        <div>
          <h1 className="page-title">🔍 Review Center</h1>
          <p className="page-subtitle">
            Review and confirm chapter assignments for matched questions
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {undoStack.length > 0 && (
            <button className="btn btn-secondary btn-sm" onClick={handleUndo} title="Undo last action">
              ↩ Undo ({undoStack.length})
            </button>
          )}
          {filter === "needs_review" && mappings.some(m => m.confidence_level === "high") && (
            <button className="btn btn-secondary btn-sm" style={{ borderColor: "var(--success)" }} onClick={handleBulkAcceptHigh}>
              ⚡ Bulk Accept High
            </button>
          )}
          <select className="select" style={{ width: 180 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="needs_review">⏳ Needs Review</option>
            <option value="all">📋 All Mappings</option>
            <option value="reviewed">✅ Already Reviewed</option>
            <option value="low">🔴 Low Only</option>
            <option value="medium">🟡 Medium Only</option>
            <option value="high">🟢 High Only</option>
          </select>
          <button className="btn btn-secondary btn-sm" onClick={load} title="Refresh">↻</button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilter("needs_review")}>
          <div className="stat-icon">⏳</div>
          <div className="stat-value">{filter === "needs_review" ? mappings.length : unreviewedMappings.length}</div>
          <div className="stat-label">Need Review</div>
        </div>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilter("reviewed")}>
          <div className="stat-icon">✅</div>
          <div className="stat-value">{filter === "reviewed" ? mappings.length : reviewedCount}</div>
          <div className="stat-label">Reviewed</div>
        </div>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilter("high")}>
          <div className="stat-icon">🟢</div>
          <div className="stat-value">{mappings.filter(m => m.confidence_level === "high").length || "0"}</div>
          <div className="stat-label">High Conf.</div>
        </div>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilter("all")}>
          <div className="stat-icon">📊</div>
          <div className="stat-value">{totalAll}</div>
          <div className="stat-label">Listed Mappings</div>
        </div>
      </div>

      {/* Confidence Spread Heatmap */}
      {mappings.length > 0 && filter === "needs_review" && (
        <div className="card" style={{ padding: 12, marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
            <span>CONFIDENCE HEATMAP (Click node to jump)</span>
            <span>{currentIndex + 1} / {mappings.length} Selected</span>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxOverflow: "hidden" }}>
            {mappings.map((m, idx) => (
              <div
                key={m.id}
                onClick={() => setCurrentIndex(idx)}
                title={`Q: ${m.question_text?.substring(0, 60)}... (${(m.confidence * 100).toFixed(0)}%)`}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  cursor: "pointer",
                  transition: "transform 0.15s ease",
                  transform: idx === currentIndex ? "scale(1.25)" : "scale(1)",
                  border: idx === currentIndex ? "2px solid #fff" : "none",
                  background:
                    m.confidence_level === "high"
                      ? "var(--success)"
                      : m.confidence_level === "medium"
                      ? "var(--warning)"
                      : "var(--danger)"
                }}
              />
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-overlay"><div className="spinner" /> Loading...</div>
      ) : mappings.length === 0 && filter === "needs_review" ? (
        <div className="empty-state card">
          <div className="empty-state-icon">🎉</div>
          <div className="empty-state-title">All caught up!</div>
          <div className="empty-state-text">
            No mappings need review. Switch to &quot;All Mappings&quot; to browse, or head to Export.
          </div>
        </div>
      ) : mappings.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-state-icon">🔍</div>
          <div className="empty-state-title">No mappings found</div>
          <div className="empty-state-text">Run matching on your question papers first.</div>
        </div>
      ) : filter === "needs_review" ? (
        /* Workspace layout with Sidebar Queue + Review Card */
        <div className="review-workspace">
          {/* Left Sidebar Queue */}
          <div className="review-sidebar">
            <div className="sidebar-header">
              Pending Queue ({mappings.length})
            </div>
            <div className="sidebar-list">
              {mappings.map((m, idx) => (
                <div
                  key={m.id}
                  onClick={() => setCurrentIndex(idx)}
                  className={`sidebar-item ${idx === currentIndex ? "active" : ""}`}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span className={`badge badge-${m.confidence_level}`} style={{ fontSize: 9, padding: "2px 4px" }}>
                      {m.confidence_level}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                      {m.question_type}
                    </span>
                  </div>
                  <div className="sidebar-question-text">
                    {m.question_text}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right Active Work Panel */}
          <div className="review-workarea">
            {current ? (
              <>
                <ReviewCard
                  mapping={current}
                  index={currentIndex}
                  total={mappings.length}
                  allChapters={allChapters}
                  onAccept={() => handleReview(current.id, "accepted")}
                  onReassign={(chIds) => handleReview(current.id, "reassigned", chIds)}
                  onSkip={handleNext}
                  onPrev={handlePrev}
                  onDelete={() => handleDelete(current.id)}
                  togglePickerRef={togglePickerRef}
                />
                
                {/* Keyboard shortcuts helper info card */}
                <div className="card" style={{ marginTop: 12, padding: 12, display: "flex", justifyContent: "space-around", fontSize: 11, color: "var(--text-dim)" }}>
                  <span>🎹 <strong>A</strong>: Accept Top Suggestion</span>
                  <span>🎹 <strong>S</strong>: Skip / Next</span>
                  <span>🎹 <strong>R</strong>: Toggle Chapter Picker</span>
                  <span>🎹 <strong>← / →</strong>: Navigate</span>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        /* Table view for browsing all/reviewed */
        <MappingsTable mappings={mappings} allChapters={allChapters} onReview={handleReview} onDelete={handleDelete} />
      )}
    </div>
  );
}

/* ── Table view for All/Reviewed ── */
function MappingsTable({ mappings, allChapters, onReview, onDelete }) {
  return (
    <div className="table-container card">
      <table>
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            <th>Question</th>
            <th>Assigned Chapter</th>
            <th>Conf.</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((m, i) => {
            const bestMatch = parseBestMatch(m.best_match);
            return (
              <tr key={m.id}>
                <td style={{ color: "var(--text-dim)" }}>{i + 1}</td>
                <td>
                  <div style={{ fontSize: 13, maxWidth: 450 }}>
                    <span className="badge badge-info" style={{ marginRight: 6 }}>{m.question_type}</span>
                    {m.question_text?.substring(0, 120)}...
                  </div>
                </td>
                <td>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    {m.final_chapter_name || bestMatch?.chapter_name || "—"}
                  </div>
                </td>
                <td>
                  <span className={`badge badge-${m.confidence_level}`}>
                    {((m.confidence || 0) * 100).toFixed(0)}%
                  </span>
                </td>
                <td>
                  {m.is_reviewed ? (
                    <span className="badge badge-high" style={{ background: "rgba(16, 185, 129, 0.2)", color: "var(--success)" }}>
                      {m.reviewer_action === "auto_accepted" ? "Auto ✓" : "Reviewed ✓"}
                    </span>
                  ) : (
                    <span className="badge badge-medium">Pending</span>
                  )}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 4 }}>
                    {!m.is_reviewed && (
                      <button className="btn btn-sm" style={{ background: "var(--success)", color: "#000" }}
                        onClick={() => onReview(m.id, "accepted")}>✓</button>
                    )}
                    <button className="btn btn-sm"
                      style={{ background: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid var(--danger)" }}
                      onClick={() => onDelete(m.id)}>🗑</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Card-based review ── */
function ReviewCard({ mapping, index, total, allChapters, onAccept, onReassign, onSkip, onPrev, onDelete, togglePickerRef }) {
  const [showChapterPicker, setShowChapterPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChapters, setSelectedChapters] = useState([]);

  // Bind toggle function to togglePickerRef
  useEffect(() => {
    if (togglePickerRef) {
      togglePickerRef.current = () => {
        setShowChapterPicker(prev => !prev);
        setSelectedChapters([]);
      };
    }
  }, [togglePickerRef]);

  const matchedChapters = parseMatchedChapters(mapping.matched_chapters);
  const bestMatch = parseBestMatch(mapping.best_match);

  const filteredChapters = allChapters.filter(ch =>
    ch.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  function toggleChapter(ch) {
    setSelectedChapters(prev => {
      const exists = prev.find(s => s.id === ch.id);
      if (exists) return prev.filter(s => s.id !== ch.id);
      return [...prev, ch];
    });
  }

  function handleAssignMultiple() {
    if (selectedChapters.length === 0) return;
    onReassign(selectedChapters.map(ch => ch.id));
    setSelectedChapters([]);
    setShowChapterPicker(false);
  }

  return (
    <div className="review-card" style={{ margin: 0 }}>
      {/* Navigation header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn btn-secondary btn-sm" onClick={onPrev} disabled={index === 0}>← Prev</button>
          <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
            {index + 1} of {total}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={onSkip} disabled={index >= total - 1}>Next →</button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className={`badge badge-${mapping.confidence_level}`}>
            {mapping.confidence_level?.toUpperCase()} — {((mapping.confidence || 0) * 100).toFixed(0)}%
          </span>
          <button className="btn btn-sm" style={{ background: "rgba(239,68,68,0.15)", color: "var(--danger)", border: "1px solid var(--danger)" }}
            onClick={onDelete} title="Delete this mapping">🗑</button>
        </div>
      </div>

      {/* Question tags */}
      <div style={{ marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="badge badge-info">{mapping.question_type}</span>
        {mapping.exam_tag && mapping.exam_tag.split(",").map((tag, i) => (
          <span key={i} className="badge badge-info" title={mapping.paper_name || mapping.exam_tag}
            style={{ background: "rgba(96, 165, 250, 0.15)", color: "#60a5fa", fontWeight: 600 }}>
            📋 {tag.trim()}
          </span>
        ))}
        {mapping.paper_name && mapping.paper_name !== mapping.exam_tag && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
            ({mapping.paper_name})
          </span>
        )}
      </div>

      {/* Question Text */}
      <div className="review-question" style={{ fontSize: 17, marginBottom: 20 }}>{mapping.question_text}</div>

      {/* Suggested chapters with scores */}
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-bright)", marginBottom: 12 }}>
        AI Suggestions (ranked by score):
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        {bestMatch && (
          <div className="review-chapter-option suggested" onClick={() => onReassign([bestMatch.chapter_id])}
            style={{ borderLeft: "4px solid var(--success)", background: "var(--accent-dim)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "var(--success)" }}>
                  ⭐ Ch {bestMatch.chapter_number || "?"}: {bestMatch.chapter_name || "Unknown"}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
                  Vector: {(bestMatch.vector_score * 100 || 0).toFixed(0)}% · Keyword: {(bestMatch.keyword_score * 100 || 0).toFixed(0)}%
                  {bestMatch.llm_score != null && ` · LLM: ${(bestMatch.llm_score * 100).toFixed(0)}%`}
                </div>
                {bestMatch.reasoning && (
                  <div style={{ fontSize: 12, color: "var(--text)", marginTop: 6, fontStyle: "italic", background: "rgba(0,0,0,0.2)", padding: "6px 10px", borderRadius: 4 }}>
                    💡 {bestMatch.reasoning}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--success)", whiteSpace: "nowrap", marginLeft: 12 }}>
                Score: {((bestMatch.combined_score || 0) * 100).toFixed(0)}% →
              </span>
            </div>
          </div>
        )}

        {matchedChapters.slice(1, 5).map((ch, i) => (
          <div key={i} className="review-chapter-option" onClick={() => onReassign([ch.chapter_id])}
            style={{ borderLeft: "4px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Ch {ch.chapter_number || "?"}: {ch.chapter_name}</div>
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
                  Vector: {(ch.vector_score * 100 || 0).toFixed(0)}% · Keyword: {(ch.keyword_score * 100 || 0).toFixed(0)}%
                </div>
              </div>
              <span style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap", marginLeft: 12 }}>
                {((ch.combined_score || 0) * 100).toFixed(0)}% →
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="btn" style={{ background: "var(--success)", color: "#000", fontWeight: 700 }} onClick={onAccept}>
          ✅ Accept Top Suggestion (A)
        </button>
        <button className="btn btn-secondary" onClick={() => { setShowChapterPicker(!showChapterPicker); setSelectedChapters([]); }}>
          {showChapterPicker ? "✕ Close Picker" : "📚 Reassign Chapter(s) (R)"}
        </button>
        <button className="btn btn-secondary" onClick={onSkip}>⏭️ Skip (S)</button>
      </div>

      {/* Multi-chapter picker */}
      {showChapterPicker && (
        <div style={{ marginTop: 16, background: "var(--surface)", borderRadius: 8, padding: 16, border: "1px solid var(--border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              Select chapters to assign — {selectedChapters.length} selected
            </div>
            {selectedChapters.length > 0 && (
              <button className="btn btn-sm" style={{ background: "var(--success)", color: "#000", fontWeight: 600 }}
                onClick={handleAssignMultiple}>
                Confirm Selection ({selectedChapters.length}) →
              </button>
            )}
          </div>

          <input
            className="input"
            placeholder="Search textbook chapters..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ marginBottom: 12 }}
          />

          {/* Selected chips */}
          {selectedChapters.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {selectedChapters.map(ch => (
                <span key={ch.id} className="badge badge-high" style={{ cursor: "pointer", padding: "4px 8px" }}
                  onClick={() => toggleChapter(ch)}>
                  {ch.name} ✕
                </span>
              ))}
            </div>
          )}

          <div style={{ maxHeight: 250, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
            {filteredChapters.map((ch) => {
              const isSelected = selectedChapters.some(s => s.id === ch.id);
              return (
                <div
                  key={ch.id}
                  onClick={() => toggleChapter(ch)}
                  style={{
                    padding: "8px 12px", cursor: "pointer", borderRadius: 0, fontSize: 13,
                    borderBottom: "1px solid var(--border)",
                    background: isSelected ? "var(--accent-glow)" : "transparent",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}
                  onMouseOver={(e) => { if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                  onMouseOut={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                >
                  <div>
                    <span style={{ marginRight: 8 }}>{isSelected ? "☑" : "☐"}</span>
                    <span style={{ fontWeight: isSelected ? 600 : 400 }}>Ch {ch.chapter_number}: {ch.name}</span>
                  </div>
                  <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                    p.{ch.start_page + 1}–{ch.end_page}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Helpers ── */
function parseBestMatch(bm) {
  if (!bm) return null;
  if (typeof bm === "string") { try { return JSON.parse(bm); } catch { return null; } }
  return bm;
}

function parseMatchedChapters(mc) {
  if (!mc) return [];
  if (typeof mc === "string") { try { return JSON.parse(mc); } catch { return []; } }
  return mc;
}
