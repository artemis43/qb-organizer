"use client";
import { useState, useEffect, useRef } from "react";
import { qbPushToFirestore, getQbFirestoreStatus, getQbPushStats, getTextbooks } from "@/lib/api";

const API_BASE = "http://localhost:8000/api";

export default function DeployPage() {
  const [textbooks, setTextbooks] = useState([]);
  const [pushStats, setPushStats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fsConnected, setFsConnected] = useState(null);
  const [selectedSubject, setSelectedSubject] = useState("");
  const [uploadImages, setUploadImages] = useState(true);
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

  const subjects = [...new Set(textbooks.map(t => t.subject))];
  const subjectStats = pushStats.find(s => s.subject === selectedSubject) || {};

  async function handlePush() {
    if (!selectedSubject) return;
    setPushing(true);
    setProgressData(null);
    setPushResult(null);
    setPushError(null);

    try {
      const result = await qbPushToFirestore(selectedSubject, null, uploadImages);
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
          // Refresh stats
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
      alert("Push failed: " + err.message);
      setPushing(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">🚀 Deploy to Firestore</h1>
          <p className="page-subtitle">Push questions + answers directly to your app&apos;s Firestore with ImageKit image upload</p>
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
            <div key={s.subject} className="stat-card" onClick={() => setSelectedSubject(s.subject)} style={{ cursor: "pointer", border: selectedSubject === s.subject ? "2px solid var(--primary)" : undefined }}>
              <div className="stat-icon">📚</div>
              <div className="stat-value">{s.subject}</div>
              <div className="stat-label">
                {s.pushable_questions} pushable / {s.total_questions} total
                {s.answered_questions > 0 && ` · ${s.answered_questions} answered`}
                {s.answers_with_images > 0 && ` · ${s.answers_with_images} with images`}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Push Controls */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title" style={{ marginBottom: 16 }}>Push to Firestore</div>
        <div className="grid-3">
          <div className="input-group">
            <label className="input-label">Subject</label>
            <select className="select" value={selectedSubject} onChange={(e) => setSelectedSubject(e.target.value)}>
              <option value="">Select subject...</option>
              {subjects.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="input-group">
            <label className="input-label">Options</label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14, padding: "10px 0" }}>
              <input
                type="checkbox"
                checked={uploadImages}
                onChange={(e) => setUploadImages(e.target.checked)}
                style={{ width: 18, height: 18 }}
              />
              Upload images to ImageKit
            </label>
          </div>
          <div className="input-group" style={{ display: "flex", alignItems: "flex-end" }}>
            <button
              className="btn btn-primary"
              onClick={handlePush}
              disabled={!selectedSubject || pushing || !fsConnected}
              style={{ width: "100%" }}
            >
              {pushing ? "⏳ Pushing..." : "🚀 Push to Firestore"}
            </button>
          </div>
        </div>

        {/* Selected Subject Stats */}
        {selectedSubject && subjectStats.total_questions > 0 && (
          <div style={{ marginTop: 16, padding: 12, background: "var(--surface)", borderRadius: 8, fontSize: 13 }}>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <span>📝 <strong>{subjectStats.pushable_questions}</strong> questions ready to push</span>
              <span>✅ <strong>{subjectStats.answered_questions}</strong> have answers</span>
              <span>🖼️ <strong>{subjectStats.answers_with_images}</strong> have images (will upload to ImageKit)</span>
            </div>
          </div>
        )}
      </div>

      {/* Progress */}
      {(progressData || pushResult || pushError) && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-title" style={{ marginBottom: 12 }}>
            {pushResult ? "✅ Push Complete" : pushError ? "❌ Push Failed" : "⏳ Push Progress"}
          </div>

          {progressData && !pushResult && !pushError && (
            <>
              <div style={{
                padding: 12, background: "var(--surface)", borderRadius: 8,
                fontSize: 13, fontFamily: "var(--mono)", marginBottom: 12,
              }}>
                {progressData.message}
              </div>

              {progressData.total > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ height: 8, background: "var(--surface)", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${progressData.percentage || 0}%`,
                      background: "var(--primary)",
                      transition: "width 0.3s ease",
                      borderRadius: 4,
                    }} />
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
                    Step {progressData.current} of {progressData.total} ({progressData.percentage}%)
                  </div>
                </div>
              )}
            </>
          )}

          {pushResult && (
            <div className="grid-4" style={{ marginTop: 16 }}>
              <div className="stat-card">
                <div className="stat-icon">📝</div>
                <div className="stat-value">{pushResult.questions || 0}</div>
                <div className="stat-label">Questions Pushed</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">📖</div>
                <div className="stat-value">{pushResult.answers || 0}</div>
                <div className="stat-label">Answers Pushed</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">🖼️</div>
                <div className="stat-value">{pushResult.images_uploaded || 0}</div>
                <div className="stat-label">Images Uploaded</div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">🔄</div>
                <div className="stat-value">{pushResult.duplicates_merged || 0}</div>
                <div className="stat-label">Duplicates Merged</div>
              </div>
            </div>
          )}

          {pushError && (
            <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>
              ⚠️ {pushError}
            </div>
          )}
        </div>
      )}

      {/* Info Note */}
      <div className="card" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.6 }}>
          <strong>How it works:</strong>
          <ul style={{ marginTop: 8, paddingLeft: 20 }}>
            <li>Pushes reviewed and high-confidence questions to Firestore</li>
            <li>Automatically creates subjects and chapters in Firestore if they don&apos;t exist</li>
            <li>Deduplicates questions and merges exam tags for frequently asked questions</li>
            <li>Uploads answer images to ImageKit CDN (same as admin dashboard)</li>
            <li>Links answers with ImageKit URLs in Firestore</li>
            <li>Existing questions in Firestore are updated, not duplicated</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
