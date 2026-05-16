"use client";
import { useState, useEffect, useRef } from "react";
import { uploadTextbook, getTextbooks, getTextbookChapters, checkTextbookBatch, deleteTextbook, connectProgress } from "@/lib/api";

export default function TextbooksPage() {
  const [textbooks, setTextbooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [expandedBook, setExpandedBook] = useState(null);
  const [chaptersData, setChaptersData] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => { loadTextbooks(); }, []);

  async function loadTextbooks() {
    try {
      setLoading(true);
      const data = await getTextbooks();
      setTextbooks(data);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function toggleBook(id) {
    if (expandedBook === id) { setExpandedBook(null); return; }
    setExpandedBook(id);
    if (!chaptersData[id]) {
      try {
        const data = await getTextbookChapters(id);
        setChaptersData(prev => ({ ...prev, [id]: data.chapters }));
      } catch (err) { setError("Failed to load chapters: " + err.message); }
    }
  }

  async function handleDelete(e, id, name) {
    e.stopPropagation();
    if (!confirm(`Delete "${name}" and ALL its chapters, chunks, and embeddings?\n\nThis cannot be undone.`)) return;
    try {
      await deleteTextbook(id);
      setExpandedBook(null);
      loadTextbooks();
    } catch (err) { alert("Delete failed: " + err.message); }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">📕 Textbooks</h1>
          <p className="page-subtitle">Upload reference textbooks and explore knowledge base</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowUpload(true)}>+ Upload Textbook</button>
      </div>

      {showUpload && <UploadForm onClose={() => setShowUpload(false)} onSuccess={() => { setShowUpload(false); loadTextbooks(); }} />}

      {error && (
        <div style={{ padding: 10, background: "var(--danger-bg)", borderRadius: 7, marginBottom: 14, fontSize: 13, color: "var(--danger)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 14 }}>✕</button>
        </div>
      )}

      {loading ? (
        <div className="loading-overlay"><div className="spinner" /> Loading...</div>
      ) : textbooks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📕</div>
          <div className="empty-state-title">No textbooks yet</div>
          <div className="empty-state-text">Upload a reference textbook PDF to build the knowledge base</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowUpload(true)}>Upload First Textbook</button>
        </div>
      ) : (
        <div>
          {textbooks.map((tb, i) => (
            <div key={tb.id} className="animate-in" style={{ animationDelay: `${i * 0.04}s` }}>
              {/* Textbook header row */}
              <div className="card" style={{ marginBottom: expandedBook === tb.id ? 0 : 12, cursor: "pointer", borderBottomLeftRadius: expandedBook === tb.id ? 0 : undefined, borderBottomRightRadius: expandedBook === tb.id ? 0 : undefined }} onClick={() => toggleBook(tb.id)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 12, color: "var(--text-dim)", transition: "transform var(--t)", transform: expandedBook === tb.id ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text-bright)" }}>{tb.name}</div>
                      <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2, fontFamily: "var(--mono)" }}>
                        {tb.subject} · {tb.total_pages} pages · {tb.total_chapters} chapters · {tb.file_size_mb}MB
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`badge badge-${tb.status === "completed" ? "high" : tb.status === "failed" ? "low" : "medium"}`}>
                      {tb.status}
                    </span>
                    {tb.status === "kb_pending" && <CheckBatchButton textbookId={tb.id} onDone={loadTextbooks} />}
                    <button className="btn btn-sm" style={{ background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid rgba(248,113,113,0.3)" }} onClick={(e) => handleDelete(e, tb.id, tb.name)} title="Delete">🗑</button>
                  </div>
                </div>
              </div>

              {/* Expanded chapter detail */}
              {expandedBook === tb.id && (
                <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 var(--r) var(--r)", marginBottom: 12, overflow: "hidden" }}>
                  {!chaptersData[tb.id] ? (
                    <div className="loading-overlay" style={{ padding: 24 }}><div className="spinner" /> Loading chapters...</div>
                  ) : (
                    <ChapterList chapters={chaptersData[tb.id]} />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChapterList({ chapters }) {
  const [expanded, setExpanded] = useState(null);
  if (!chapters || chapters.length === 0) return <div style={{ padding: 16, fontSize: 13, color: "var(--text-dim)" }}>No chapters found</div>;

  return (
    <div>
      {chapters.map((ch) => (
        <div key={ch.id}>
          <div className="chapter-row" onClick={() => setExpanded(expanded === ch.id ? null : ch.id)}>
            <span style={{ fontSize: 10, color: "var(--text-dim)", transition: "transform var(--t)", transform: expanded === ch.id ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
            <span className="chapter-num">{String(ch.chapter_number).padStart(2, "0")}</span>
            <span className="chapter-name">{ch.name}</span>
            <span className="chapter-pages">{(ch.start_page||0)+1}–{ch.end_page||"?"}</span>
            <span className="chapter-status-badge" style={ch.status === "completed" ? { color: "var(--success)", borderColor: "rgba(52,211,153,0.3)" } : {}}>
              {ch.status === "completed" ? "✓ KB" : ch.status}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>{ch.chunk_count || ch.total_chunks || 0} chunks</span>
          </div>

          {expanded === ch.id && (
            <div className="chapter-detail">
              {/* Summary */}
              {ch.summary && (
                <>
                  <div className="chapter-detail-label">Summary</div>
                  <div className="chapter-summary-text">{ch.summary}</div>
                </>
              )}

              {/* Topics */}
              {ch.topics && ch.topics.length > 0 && (
                <>
                  <div className="chapter-detail-label">Topics ({ch.topics.length})</div>
                  <div className="chapter-tags">
                    {ch.topics.slice(0, 30).map((t, i) => (
                      <span key={i} className="chapter-tag">{typeof t === "string" ? t : t.topic || t.name || JSON.stringify(t)}</span>
                    ))}
                    {ch.topics.length > 30 && <span className="chapter-tag" style={{ opacity: 0.5 }}>+{ch.topics.length - 30} more</span>}
                  </div>
                </>
              )}

              {/* Key Terms */}
              {ch.key_terms && ch.key_terms.length > 0 && (
                <>
                  <div className="chapter-detail-label">Key Terms ({ch.key_terms.length})</div>
                  <div className="chapter-tags">
                    {ch.key_terms.slice(0, 20).map((t, i) => (
                      <span key={i} className="chapter-tag" style={{ background: "rgba(52,211,153,0.08)", color: "var(--success)", borderColor: "rgba(52,211,153,0.15)" }}>{typeof t === "string" ? t : JSON.stringify(t)}</span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CheckBatchButton({ textbookId, onDone }) {
  const [checking, setChecking] = useState(false);
  async function handleCheck(e) {
    e.stopPropagation();
    setChecking(true);
    try {
      const result = await checkTextbookBatch(textbookId);
      alert(`Batch: ${result.message || JSON.stringify(result)}`);
      onDone();
    } catch (err) { alert("Error: " + err.message); }
    finally { setChecking(false); }
  }
  return <button className="btn btn-secondary btn-sm" onClick={handleCheck} disabled={checking}>{checking ? "..." : "Check Batch"}</button>;
}

function UploadForm({ onClose, onSuccess }) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  function handleDrop(e) {
    e.preventDefault(); setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type === "application/pdf") {
      setFile(dropped);
      if (!name) setName(dropped.name.replace(/\.pdf$/i, "").replace(/[_-]/g, " "));
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file || !name || !subject) return;
    setUploading(true);
    try {
      const result = await uploadTextbook(file, name, subject);
      if (result.task_id) {
        connectProgress(result.task_id, (data) => {
          setProgress(data);
          if (data.step === "done") setTimeout(() => onSuccess(), 1500);
          if (data.step === "error") setUploading(false);
        }, () => {
          setProgress({ message: "Connection lost. Check server terminal.", percentage: 0 });
        });
      } else { onSuccess(); }
    } catch (err) { alert("Upload failed: " + err.message); setUploading(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header">
        <span className="card-title">Upload Textbook</span>
        <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
      </div>
      <form onSubmit={handleSubmit}>
        <div className={`file-upload-zone ${dragOver ? "drag-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
          onClick={() => fileRef.current.click()} style={{ marginBottom: 14 }}>
          <input ref={fileRef} type="file" accept=".pdf" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files[0]; if (f) { setFile(f); if (!name) setName(f.name.replace(/\.pdf$/i, "").replace(/[_-]/g, " ")); } }} />
          {file ? (
            <><div className="file-upload-icon">✅</div><div className="file-upload-text">{file.name}</div><div className="file-upload-hint">{(file.size/1024/1024).toFixed(1)} MB</div></>
          ) : (
            <><div className="file-upload-icon">📕</div><div className="file-upload-text">Drop a textbook PDF here or click to select</div><div className="file-upload-hint">Supports digital PDFs with selectable text</div></>
          )}
        </div>
        <div className="grid-2">
          <div className="input-group">
            <label className="input-label">Textbook Name</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Maheswari's Essential Orthopaedics" required />
          </div>
          <div className="input-group">
            <label className="input-label">Subject</label>
            <input className="input" value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Orthopaedics" required />
          </div>
        </div>
        {progress && (
          <div style={{ marginBottom: 14 }}>
            <div className="progress-bar-container"><div className="progress-bar-fill" style={{ width: `${progress.percentage || 0}%` }} /></div>
            <div className="progress-text"><span style={{ maxWidth: "80%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{progress.message}</span><span>{(progress.percentage||0).toFixed(0)}%</span></div>
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={uploading || !file || !name || !subject}>
          {uploading ? "Processing..." : "Upload & Process"}
        </button>
      </form>
    </div>
  );
}
