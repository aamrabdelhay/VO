"use client";

import { useCallback, useEffect, useState } from "react";

type Evidence = {
  id: string;
  source: string;
  problemDescription: string;
  validationOutput: string;
  createdAt: string;
};

type Lesson = {
  id: string;
  title: string;
  content: string;
  importance: number;
  projectId: string;
  projectName: string;
  createdAt: string;
  evidence: Evidence[];
};

type Counts = { candidates: number; approved: number; rejected: number };

type ApiPayload = {
  data?: { lessons?: Lesson[]; counts?: Counts };
  error?: { message?: string };
};

export function GarvexEvolutionReview({ csrf }: { csrf: string }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [counts, setCounts] = useState<Counts>({ candidates: 0, approved: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/admin/garvex/evolution/lessons", { cache: "no-store" });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok) throw new Error(payload.error?.message ?? "Could not load lesson candidates.");
      setLessons(payload.data?.lessons ?? []);
      setCounts(payload.data?.counts ?? { candidates: 0, approved: 0, rejected: 0 });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const review = async (lessonId: string, decision: "approve" | "reject") => {
    setBusyId(lessonId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/v1/admin/garvex/evolution/lessons/" + encodeURIComponent(lessonId), {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ decision }),
      });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok) throw new Error(payload.error?.message ?? "The review could not be saved.");
      setNotice(decision === "approve"
        ? "Lesson approved. It can now be retrieved for this project."
        : "Lesson rejected. It will not be used by Garvex.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="garvex-evolution-review" aria-label="Garvex verified learning review">
      <header className="garvex-evolution-head">
        <div>
          <span className="garvex-evolution-kicker">EVIDENCE-GATED LEARNING</span>
          <h2>Review Garvex lessons</h2>
          <p>Only examples that passed install, tests, and build can produce candidates. Approval is manual and keeps each lesson scoped to its project.</p>
        </div>
        <button type="button" className="garvex-evolution-refresh" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>

      <div className="garvex-evolution-counts" aria-label="Lesson counts">
        <span><b>{counts.candidates}</b> Awaiting review</span>
        <span><b>{counts.approved}</b> Approved</span>
        <span><b>{counts.rejected}</b> Rejected</span>
      </div>

      {error ? <p className="garvex-evolution-alert error" role="alert">{error}</p> : null}
      {notice ? <p className="garvex-evolution-alert success" role="status">{notice}</p> : null}
      {loading && lessons.length === 0 ? <p className="garvex-evolution-empty">Loading lesson candidates…</p> : null}
      {!loading && lessons.length === 0 && !error ? (
        <p className="garvex-evolution-empty">No lessons are waiting for review. Run the Garvex Evolution workflow after at least one self-practice repair has passed verification.</p>
      ) : null}

      <div className="garvex-evolution-list">
        {lessons.map((lesson) => (
          <article className="garvex-evolution-card" key={lesson.id}>
            <div className="garvex-evolution-meta">
              <span>{lesson.projectName}</span>
              <time dateTime={lesson.createdAt}>{new Date(lesson.createdAt).toLocaleString()}</time>
            </div>
            <h3>{lesson.title}</h3>
            <p>{lesson.content}</p>
            <div className="garvex-evolution-evidence">
              <strong>Verified evidence · {lesson.evidence.length}</strong>
              {lesson.evidence.map((item) => (
                <details key={item.id}>
                  <summary>{item.source} · {item.problemDescription}</summary>
                  <pre>{item.validationOutput || "No validation output was recorded."}</pre>
                </details>
              ))}
              {lesson.evidence.length === 0 ? <span>Evidence is unavailable; this candidate cannot be approved.</span> : null}
            </div>
            <div className="garvex-evolution-actions">
              <button type="button" onClick={() => void review(lesson.id, "approve")} disabled={busyId !== null || lesson.evidence.length === 0}>
                {busyId === lesson.id ? "Saving…" : "Approve lesson"}
              </button>
              <button type="button" className="secondary" onClick={() => void review(lesson.id, "reject")} disabled={busyId !== null}>
                Reject
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
