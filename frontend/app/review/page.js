"use client";
import { useState, useEffect } from "react";
import { getMappings, reviewMapping, getChapters, deleteMapping } from "@/lib/api";

export default function ReviewPage() {
  const [mappings, setMappings] = useState([]);
  const [allChapters, setAllChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("needs_review");
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => { load(); }, [filter]);

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
    } catch (err) { console.error(err); }
    setLoading(false);
  }

  async function handleReview(mappingId, action, chapterIds = null) {
    try {
      await reviewMapping(mappingId, action, chapterIds);
      setMappings(prev => prev.map(m =>
        m.id === mappingId ? { ...m, is_reviewed: true, reviewer_action: action } : m
      ));
      // Auto-advance to next unreviewed
      const nextUnreviewed = mappings.findIndex((m, i) => i > currentIndex && !m.is_reviewed);
      if (nextUnreviewed >= 0) {
        setCurrentIndex(nextUnreviewed);
      } else {
        setCurrentIndex(prev => Math.min(prev + 1, mappings.length - 1));
      }
    } catch (err) {
      alert("Review failed: " + err.message);
    }
  }

  async function handleDelete(mappingId) {
    if (!confirm("Delete this mapping?")) return;
    try {
      await deleteMapping(mappingId);
      setMappings(prev => prev.filter(m => m.id !== mappingId));
    } catch (err) { alert("Delete failed: " + err.message); }
  }

  const totalAll = mappings.length;
  const reviewedCount = mappings.filter(m => m.is_reviewed).length;
  const unreviewedMappings = mappings.filter(m => !m.is_reviewed);
  const current = filter === "needs_review" ? unreviewedMappings[currentIndex] : mappings[currentIndex];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">🔍 Review Center</h1>
          <p className="page-subtitle">
            Review and confirm chapter assignments for matched questions
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select className="select" style={{ width: 180 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="needs_review">⏳ Needs Review</option>
            <option value="all">📋 All Mappings</option>
            <option value="reviewed">✅ Already Reviewed</option>
            <option value="low">🔴 Low Only</option>
            <option value="medium">🟡 Medium Only</option>
            <option value="high">🟢 High Only</option>
          </select>
          <button className="btn btn-secondary btn-sm" onClick={load}>↻</button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilter("needs_review")}>
          <div className="stat-icon">⏳</div>
          <div className="stat-value">{unreviewedMappings.length}</div>
          <div className="stat-label">Need Review</div>
        </div>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilter("reviewed")}>
          <div className="stat-icon">✅</div>
          <div className="stat-value">{reviewedCount}</div>
          <div className="stat-label">Reviewed</div>
        </div>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilter("high")}>
          <div className="stat-icon">🟢</div>
          <div className="stat-value">{mappings.filter(m => m.confidence_level === "high").length || "–"}</div>
          <div className="stat-label">High Conf.</div>
        </div>
        <div className="stat-card" style={{ cursor: "pointer" }} onClick={() => setFilter("all")}>
          <div className="stat-icon">📊</div>
          <div className="stat-value">{totalAll}</div>
          <div className="stat-label">Total</div>
        </div>
      </div>

      {/* Progress */}
      {filter === "needs_review" && unreviewedMappings.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="progress-bar-container">
            <div className="progress-bar-fill" style={{ width: `${totalAll > 0 ? (reviewedCount / totalAll) * 100 : 0}%` }} />
          </div>
          <div className="progress-text">
            <span>{reviewedCount} / {totalAll} reviewed</span>
            <span>{unreviewedMappings.length} remaining</span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-overlay"><div className="spinner" /> Loading...</div>
      ) : mappings.length === 0 && filter === "needs_review" ? (
        <div className="empty-state">
          <div className="empty-state-icon">🎉</div>
          <div className="empty-state-title">All caught up!</div>
          <div className="empty-state-text">
            No mappings need review. Switch to &quot;All Mappings&quot; to browse, or head to Export.
          </div>
        </div>
      ) : mappings.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <div className="empty-state-title">No mappings found</div>
          <div className="empty-state-text">Run matching on your question papers first.</div>
        </div>
      ) : filter === "needs_review" ? (
        /* Card-based review mode for unreviewed */
        current ? (
          <ReviewCard
            mapping={current}
            index={currentIndex}
            total={unreviewedMappings.length}
            allChapters={allChapters}
            onAccept={() => handleReview(current.id, "accepted")}
            onReassign={(chIds) => handleReview(current.id, "reassigned", chIds)}
            onSkip={() => setCurrentIndex(prev => Math.min(prev + 1, unreviewedMappings.length - 1))}
            onPrev={() => setCurrentIndex(prev => Math.max(prev - 1, 0))}
            onDelete={() => handleDelete(current.id)}
          />
        ) : null
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
    <div className="table-container">
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
                  <div style={{ fontSize: 13, maxWidth: 350 }}>
                    <span className="badge badge-info" style={{ marginRight: 6 }}>{m.question_type}</span>
                    {m.question_text?.substring(0, 80)}...
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
                    <span className="badge badge-high">{m.reviewer_action === "auto_accepted" ? "Auto ✓" : "Reviewed ✓"}</span>
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
                      style={{ background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger)" }}
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
function ReviewCard({ mapping, index, total, allChapters, onAccept, onReassign, onSkip, onPrev, onDelete }) {
  const [showChapterPicker, setShowChapterPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChapters, setSelectedChapters] = useState([]);

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
    // Send first as primary, rest as secondary
    onReassign(selectedChapters.map(ch => ch.id));
    setSelectedChapters([]);
    setShowChapterPicker(false);
  }

  return (
    <div className="review-card">
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
          <button className="btn btn-sm" style={{ background: "var(--danger-bg)", color: "var(--danger)" }}
            onClick={onDelete} title="Delete this mapping">🗑</button>
        </div>
      </div>

      {/* Question */}
      <div style={{ marginBottom: 4, display: "flex", gap: 8 }}>
        <span className="badge badge-info">{mapping.question_type}</span>
        {mapping.exam_tag && <span className="badge badge-info">{mapping.exam_tag}</span>}
      </div>
      <div className="review-question">{mapping.question_text}</div>

      {/* Suggested chapters with scores */}
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 8, marginTop: 16 }}>
        AI Suggestions (ranked by score):
      </div>

      {bestMatch && (
        <div className="review-chapter-option suggested" onClick={() => onReassign([bestMatch.chapter_id])}
          style={{ cursor: "pointer", borderLeft: "3px solid var(--success)", paddingLeft: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                ⭐ {bestMatch.chapter_name || "Unknown"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
                Vector: {(bestMatch.vector_score * 100 || 0).toFixed(0)}% · Keyword: {(bestMatch.keyword_score * 100 || 0).toFixed(0)}%
                {bestMatch.llm_score != null && ` · LLM: ${(bestMatch.llm_score * 100).toFixed(0)}%`}
              </div>
              {bestMatch.reasoning && (
                <div style={{ fontSize: 12, color: "var(--accent)", marginTop: 4, fontStyle: "italic" }}>
                  💡 {bestMatch.reasoning}
                </div>
              )}
            </div>
            <span style={{ fontSize: 12, color: "var(--success)", whiteSpace: "nowrap" }}>
              Score: {((bestMatch.combined_score || 0) * 100).toFixed(0)}% →
            </span>
          </div>
        </div>
      )}

      {matchedChapters.slice(1, 5).map((ch, i) => (
        <div key={i} className="review-chapter-option" onClick={() => onReassign([ch.chapter_id])}
          style={{ cursor: "pointer", borderLeft: "3px solid var(--border)", paddingLeft: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 14 }}>{ch.chapter_name}</div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                Vector: {(ch.vector_score * 100 || 0).toFixed(0)}% · Keyword: {(ch.keyword_score * 100 || 0).toFixed(0)}%
              </div>
            </div>
            <span style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
              {((ch.combined_score || 0) * 100).toFixed(0)}% →
            </span>
          </div>
        </div>
      ))}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button className="btn" style={{ background: "var(--success)", color: "#000", fontWeight: 600 }} onClick={onAccept}>
          ✅ Accept Top Suggestion
        </button>
        <button className="btn btn-secondary" onClick={() => { setShowChapterPicker(!showChapterPicker); setSelectedChapters([]); }}>
          {showChapterPicker ? "✕ Close" : "📚 Assign to Chapter(s)"}
        </button>
        <button className="btn btn-secondary" onClick={onSkip}>⏭️ Skip</button>
      </div>

      {/* Multi-chapter picker */}
      {showChapterPicker && (
        <div style={{ marginTop: 16, background: "var(--surface)", borderRadius: 8, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              Select chapter(s) — {selectedChapters.length} selected
            </div>
            {selectedChapters.length > 0 && (
              <button className="btn btn-sm" style={{ background: "var(--success)", color: "#000" }}
                onClick={handleAssignMultiple}>
                Assign {selectedChapters.length} Chapter{selectedChapters.length > 1 ? "s" : ""} →
              </button>
            )}
          </div>

          <input
            className="input"
            placeholder="Search chapters..."
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

          <div style={{ maxHeight: 250, overflow: "auto" }}>
            {filteredChapters.map((ch) => {
              const isSelected = selectedChapters.find(s => s.id === ch.id);
              return (
                <div
                  key={ch.id}
                  onClick={() => toggleChapter(ch)}
                  style={{
                    padding: "8px 12px", cursor: "pointer", borderRadius: 6, fontSize: 13,
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
