// qb-organizer/frontend/lib/api.js
/**
 * API client for communicating with the FastAPI backend.
 */

const API_BASE = "http://localhost:8000/api";

async function fetchAPI(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API error ${res.status}: ${errorText}`);
  }

  return res.json();
}

// ── Dashboard ──
export async function getDashboard() {
  return fetchAPI("/dashboard");
}

// ── Textbooks ──
export async function uploadTextbook(file, name, subject) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("name", name);
  formData.append("subject", subject);

  const res = await fetch(`${API_BASE}/textbooks/upload`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

export async function getTextbooks() {
  return fetchAPI("/textbooks");
}

export async function getTextbook(id) {
  return fetchAPI(`/textbooks/${id}`);
}

export async function checkTextbookBatch(id) {
  return fetchAPI(`/textbooks/${id}/check-batch`, { method: "POST" });
}

// ── Question Papers ──
export async function uploadQP(file, subject, metadata = {}) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("subject", subject);
  if (metadata.university) formData.append("university", metadata.university);
  if (metadata.year) formData.append("year", metadata.year);
  if (metadata.month) formData.append("month", metadata.month);
  if (metadata.schema) formData.append("schema", metadata.schema);

  const res = await fetch(`${API_BASE}/papers/upload`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

export async function uploadBatchQPs(files, subject) {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  formData.append("subject", subject);

  const res = await fetch(`${API_BASE}/papers/upload-batch`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

export async function getPapers(subject = null) {
  const path = subject ? `/papers?subject=${encodeURIComponent(subject)}` : "/papers";
  return fetchAPI(path);
}

export async function getQPQuestions(qpId) {
  return fetchAPI(`/papers/${qpId}/questions`);
}

// ── Matching ──
export async function runMatching(subject, textbookId, paperIds = null) {
  const formData = new FormData();
  formData.append("subject", subject);
  formData.append("textbook_id", textbookId);
  if (paperIds && paperIds.length > 0) {
    formData.append("paper_ids", paperIds.join(","));
  }

  const res = await fetch(`${API_BASE}/match`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

export async function getMappings(subject = null, confidenceLevel = null) {
  const params = new URLSearchParams();
  if (subject) params.append("subject", subject);
  if (confidenceLevel) params.append("confidence_level", confidenceLevel);
  const qs = params.toString();
  return fetchAPI(`/mappings${qs ? "?" + qs : ""}`);
}

export async function reviewMapping(mappingId, action, chapterIds = null) {
  // chapterIds can be a single string or an array
  const body = { action };
  if (chapterIds) {
    body.chapter_ids = Array.isArray(chapterIds) ? chapterIds : [chapterIds];
  }
  return fetchAPI(`/mappings/${mappingId}/review`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ── Chapters ──
export async function getChapters(subject = null, textbookId = null) {
  const params = new URLSearchParams();
  if (subject) params.append("subject", subject);
  if (textbookId) params.append("textbook_id", textbookId);
  const qs = params.toString();
  return fetchAPI(`/chapters${qs ? "?" + qs : ""}`);
}

// ── Export ──
export async function exportSubject(subject, universityId = "") {
  const formData = new FormData();
  formData.append("subject", subject);
  formData.append("university_id", universityId);

  const res = await fetch(`${API_BASE}/export`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

export function getExportDownloadUrl(subject) {
  return `${API_BASE}/export/download/${encodeURIComponent(subject)}`;
}

// ── Status ──
export async function getStatus() {
  return fetchAPI("/status");
}

export async function getLogs() {
  return fetchAPI("/logs");
}

// ── Delete ──
export async function deleteTextbook(id) {
  return fetchAPI(`/textbooks/${id}`, { method: "DELETE" });
}

export async function deletePaper(id) {
  return fetchAPI(`/papers/${id}`, { method: "DELETE" });
}

export async function deleteMapping(id) {
  return fetchAPI(`/mappings/${id}`, { method: "DELETE" });
}

export async function deleteAllMappings(subject = null) {
  const qs = subject ? `?subject=${encodeURIComponent(subject)}` : "";
  return fetchAPI(`/mappings${qs}`, { method: "DELETE" });
}

export async function fullReset() {
  return fetchAPI("/reset", { method: "POST" });
}

// ── SSE Progress Stream ──
export function connectProgress(taskId, onMessage, onError) {
  const evtSource = new EventSource(`${API_BASE}/progress/${taskId}`);

  evtSource.addEventListener("progress", (event) => {
    const data = JSON.parse(event.data);
    onMessage(data);
    if (data.step === "done" || data.step === "error") {
      evtSource.close();
    }
  });

  evtSource.addEventListener("timeout", () => {
    evtSource.close();
    if (onError) onError("Connection timed out");
  });

  evtSource.onerror = () => {
    evtSource.close();
    if (onError) onError("Connection lost");
  };

  return evtSource;
}

// ── Settings ──
export async function getSettings() {
  return fetchAPI("/settings");
}

export async function updateSettings(data) {
  return fetchAPI("/settings", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function getSystemInfo() {
  return fetchAPI("/settings/sysinfo");
}

// ── Textbook Chapters Detail ──
export async function getTextbookChapters(textbookId) {
  return fetchAPI(`/textbooks/${textbookId}/chapters`);
}

// ── Subjects ──
export async function getSubjects() {
  return fetchAPI("/subjects");
}

// ── Answers ──
export async function getAnswerPresets() {
  return fetchAPI("/answers/presets");
}

export async function generateAnswers(mappingIds, preset, customBulletCount, customStyle, mode = "auto") {
  const formData = new FormData();
  formData.append("mapping_ids", mappingIds.join(","));
  formData.append("preset", preset);
  if (customBulletCount) formData.append("custom_bullet_count", customBulletCount);
  if (customStyle) formData.append("custom_style", customStyle);
  formData.append("mode", mode);

  const res = await fetch(`${API_BASE}/answers/generate`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

export async function getAnswers(subject, chapterId, status) {
  const params = new URLSearchParams();
  if (subject) params.append("subject", subject);
  if (chapterId) params.append("chapter_id", chapterId);
  if (status) params.append("status", status);
  const qs = params.toString();
  return fetchAPI(`/answers${qs ? "?" + qs : ""}`);
}

export async function getAnswerForMapping(mappingId) {
  return fetchAPI(`/answers/${mappingId}`);
}

export async function updateAnswer(answerId, data) {
  return fetchAPI(`/answers/${answerId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteAnswer(answerId) {
  return fetchAPI(`/answers/${answerId}`, { method: "DELETE" });
}

export async function regenerateAnswer(answerId, preset, customBulletCount, customStyle) {
  const formData = new FormData();
  if (preset) formData.append("preset", preset);
  if (customBulletCount) formData.append("custom_bullet_count", customBulletCount);
  if (customStyle) formData.append("custom_style", customStyle);

  const res = await fetch(`${API_BASE}/answers/${answerId}/regenerate`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

export async function getAnswerStats() {
  return fetchAPI("/answers/stats");
}

// ── QB Firestore Push ──
export async function qbPushToFirestore(subject, mappingIds = null, uploadImages = true, dryRun = false) {
  return fetchAPI("/qb/push-to-firestore", {
    method: "POST",
    body: JSON.stringify({
      subject,
      mapping_ids: mappingIds,
      upload_images: uploadImages,
      dry_run: dryRun,
    }),
  });
}

export async function getQbFirestoreStatus() {
  return fetchAPI("/qb/firestore-status");
}

export async function getQbPushStats() {
  return fetchAPI("/qb/push-stats");
}

// ── Viva Organizer ──
export async function vivaGenerate(subject, textbookId, chapterIds = null, questionsPerChapter = 8) {
  const formData = new FormData();
  formData.append("subject", subject);
  formData.append("textbook_id", textbookId);
  if (chapterIds && chapterIds.length > 0) formData.append("chapter_ids", chapterIds.join(","));
  formData.append("questions_per_chapter", questionsPerChapter);

  const res = await fetch(`${API_BASE}/viva/generate`, { method: "POST", body: formData });
  return res.json();
}

export async function getVivaQuestions(subject = null, status = null, importance = null) {
  const params = new URLSearchParams();
  if (subject) params.append("subject", subject);
  if (status) params.append("status", status);
  if (importance) params.append("importance", importance);
  const qs = params.toString();
  return fetchAPI(`/viva/questions${qs ? "?" + qs : ""}`);
}

export async function getVivaStats() {
  return fetchAPI("/viva/stats");
}

export async function addVivaManual(data) {
  return fetchAPI("/viva/manual", { method: "POST", body: JSON.stringify(data) });
}

export async function updateVivaQuestion(id, data) {
  return fetchAPI(`/viva/questions/${id}`, { method: "PUT", body: JSON.stringify(data) });
}

export async function deleteVivaQuestion(id) {
  return fetchAPI(`/viva/questions/${id}`, { method: "DELETE" });
}

export async function deleteVivaQuestions(subject = null, status = null) {
  const params = new URLSearchParams();
  if (subject) params.append("subject", subject);
  if (status) params.append("status", status);
  const qs = params.toString();
  return fetchAPI(`/viva/questions${qs ? "?" + qs : ""}`, { method: "DELETE" });
}

export async function vivaAutoTag(questionIds, subject) {
  const formData = new FormData();
  formData.append("question_ids", questionIds.join(","));
  formData.append("subject", subject);

  const res = await fetch(`${API_BASE}/viva/auto-tag`, { method: "POST", body: formData });
  return res.json();
}

export async function vivaPushToFirestore(questionIds) {
  const formData = new FormData();
  formData.append("question_ids", questionIds.join(","));

  const res = await fetch(`${API_BASE}/viva/push-to-firestore`, { method: "POST", body: formData });
  return res.json();
}

export async function getVivaFirestoreStatus() {
  return fetchAPI("/viva/firestore-status");
}

// ── Knowledge Graph ──
export async function kgBuild(textbookId) {
  const id = textbookId && typeof textbookId === "object" ? textbookId.id : String(textbookId || "");
  if (!id || id === "[object Object]") throw new Error("Invalid textbook ID: " + JSON.stringify(textbookId));
  const res = await fetch(`${API_BASE}/knowledge/build/${encodeURIComponent(id)}`, { method: "POST" });
  return res.json();
}

export async function kgProcessBatch(textbookId) {
  const id = textbookId && typeof textbookId === "object" ? textbookId.id : String(textbookId || "");
  if (!id || id === "[object Object]") throw new Error("Invalid textbook ID: " + JSON.stringify(textbookId));
  return fetchAPI(`/knowledge/batch/${encodeURIComponent(id)}`, { method: "POST" });
}

export async function kgExtractRelations(textbookId) {
  const id = textbookId && typeof textbookId === "object" ? textbookId.id : String(textbookId || "");
  if (!id || id === "[object Object]") throw new Error("Invalid textbook ID: " + JSON.stringify(textbookId));
  return fetchAPI(`/knowledge/extract-relations/${encodeURIComponent(id)}`, { method: "POST" });
}

export async function kgProcessRelations(textbookId) {
  const id = textbookId && typeof textbookId === "object" ? textbookId.id : String(textbookId || "");
  if (!id || id === "[object Object]") throw new Error("Invalid textbook ID: " + JSON.stringify(textbookId));
  return fetchAPI(`/knowledge/process-relations/${encodeURIComponent(id)}`, { method: "POST" });
}

export async function kgGetStats(subject = null) {
  const qs = subject ? `?subject=${encodeURIComponent(subject)}` : "";
  return fetchAPI(`/knowledge/stats${qs}`);
}

export async function kgSearch(query = "", subject = null, conceptType = null, importance = null, limit = 50) {
  const params = new URLSearchParams();
  if (query) params.append("q", query);
  if (subject) params.append("subject", subject);
  if (conceptType) params.append("concept_type", conceptType);
  if (importance) params.append("importance", importance);
  if (limit) params.append("limit", limit);
  const qs = params.toString();
  return fetchAPI(`/knowledge/search${qs ? "?" + qs : ""}`);
}

export async function kgGetConcept(conceptId) {
  return fetchAPI(`/knowledge/concepts/${conceptId}`);
}

export async function kgGetGraph(subject = null, conceptType = null, limit = 150) {
  const params = new URLSearchParams();
  if (subject) params.append("subject", subject);
  if (conceptType) params.append("concept_type", conceptType);
  if (limit) params.append("limit", limit);
  const qs = params.toString();
  return fetchAPI(`/knowledge/graph${qs ? "?" + qs : ""}`);
}

export async function kgGetNeighbors(conceptId) {
  return fetchAPI(`/knowledge/neighbors/${conceptId}`);
}

export async function kgDeleteConcept(conceptId) {
  return fetchAPI(`/knowledge/concepts/${conceptId}`, { method: "DELETE" });
}

export async function kgDeleteAll(subject = null) {
  const qs = subject ? `?subject=${encodeURIComponent(subject)}` : "";
  return fetchAPI(`/knowledge${qs}`, { method: "DELETE" });
}

export async function kgAddConcept(data) {
  return fetchAPI("/knowledge/concepts", { method: "POST", body: JSON.stringify(data) });
}

export async function kgAddRelation(data) {
  return fetchAPI("/knowledge/relations", { method: "POST", body: JSON.stringify(data) });
}

export async function kgGetConceptTypes() {
  return fetchAPI("/knowledge/concept-types");
}

