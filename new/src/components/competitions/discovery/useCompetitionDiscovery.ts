"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { discoverySubmissionSchema, validateDiscoveryStep, type DiscoveryFieldAnswer, type DiscoveryFieldId, type DiscoverySubmission } from "@/lib/competitions/discovery/contracts";
import { DISCOVERY_SCHEMA_VERSION } from "@/lib/competitions/discovery/contracts";
import { DISCOVERY_QUESTIONS } from "@/lib/competitions/discovery/questionnaire";
import { DISCOVERY_CONSENT_VERSION } from "@/lib/competitions/discovery/disclosure";
import type { DiscoverySnapshot } from "@/lib/competitions/discovery/transport";
import { DISCOVERY_BROWSER_STORAGE_KEY, applyDiscoveryEvent, discoveryDraftChanged, discoveryEventSchema, discoveryNeedsReportVerification, discoveryRunEnded, discoverySnapshotSchema, emptyDiscoveryBrowserState, hasNewerDiscoveryBrowserRecord, migrateDiscoveryBrowserDraft, readDiscoveryBrowserState, type DiscoveryBrowserState } from "./discovery-client-state";
import { readDiscoveryEventStream } from "./discovery-stream";

const API = "/api/ai/competition-discovery";
type Connection = "idle" | "connecting" | "live" | "reconnecting";
type JsonRecord = Record<string, unknown>;
class DiscoveryHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
function admissionRejected(error: unknown): boolean {
  return error instanceof DiscoveryHttpError && (error.code === "DISCOVERY_BUSY" || error.code === "DISCOVERY_MAINTENANCE");
}

function requestHeaders(token?: string): HeadersInit {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function requestJson(path: string, init: RequestInit = {}): Promise<JsonRecord> {
  const response = await fetch(`${API}${path}`, { cache: "no-store", ...init });
  let value: unknown;
  try { value = await response.json(); } catch { throw new DiscoveryHttpError("暂时没有收到完整响应，请稍后重试。", response.status); }
  const body = value && typeof value === "object" ? value as JsonRecord : {};
  if (!response.ok) {
    const fallback = response.status === 401 || response.status === 410 ? "这次问答已到期，请清除后重新开始。" : response.status === 429 ? "当前请求较多，请稍后重试。" : "这次请求没有完成，可以原地重试。";
    throw new DiscoveryHttpError(typeof body.message === "string" ? body.message : fallback, response.status,
      typeof body.error === "string" ? body.error : undefined);
  }
  return body;
}
function waitBeforeReconnect(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { window.clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = window.setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "暂时没有完成，请重试。"; }

export function useCompetitionDiscovery() {
  const [state, setState] = useState<DiscoveryBrowserState>(() => emptyDiscoveryBrowserState());
  const current = useRef(state);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connection, setConnection] = useState<Connection>("idle");
  const [toolStatus, setToolStatus] = useState("");
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [newerRecordAvailable, setNewerRecordAvailable] = useState(false);
  const storageBlocked = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const stream = useRef<AbortController | null>(null);
  const streamGeneration = useRef(0);
  const commit = useCallback((updater: DiscoveryBrowserState | ((previous: DiscoveryBrowserState) => DiscoveryBrowserState)) => {
    const next = typeof updater === "function" ? updater(current.current) : updater;
    current.current = next;
    setState(next);
  }, []);
  const stopBrowserWork = useCallback(() => {
    operation.current?.abort(); operation.current = null;
    stream.current?.abort(); stream.current = null;
    streamGeneration.current += 1;
    setConnection("idle");
  }, []);
  const saveLocal = useCallback(() => {
    if (storageBlocked.current) return;
    try {
      if (hasNewerDiscoveryBrowserRecord(current.current, window.localStorage.getItem(DISCOVERY_BROWSER_STORAGE_KEY))) {
        storageBlocked.current = true; setNewerRecordAvailable(true); stopBrowserWork(); return;
      }
      window.localStorage.setItem(DISCOVERY_BROWSER_STORAGE_KEY, JSON.stringify(current.current));
      setStorageUnavailable(false);
    } catch { setStorageUnavailable(true); }
  }, [stopBrowserWork]);

  const installSnapshot = useCallback((snapshot: DiscoverySnapshot) => {
    commit(previous => ({ ...previous, snapshot, expiresAt: snapshot.expiresAt,
      session: previous.session ? { ...previous.session, expiresAt: snapshot.expiresAt, runId: snapshot.run?.runId ?? previous.session.runId } : null,
    }));
  }, [commit]);

  const resetLocal = useCallback((message: string) => {
    stopBrowserWork(); setBusy(false); setError(""); setDeleteFailed(false); setToolStatus("");
    try {
      if (storageBlocked.current || hasNewerDiscoveryBrowserRecord(current.current, window.localStorage.getItem(DISCOVERY_BROWSER_STORAGE_KEY))) {
        storageBlocked.current = true; setNewerRecordAvailable(true); return;
      }
    } catch { /* UI can still be reset. */ }
    const next = emptyDiscoveryBrowserState(Math.max(Date.now(), current.current.recordCreatedAt + 1));
    commit(next); setNotice(message);
    try { window.localStorage.setItem(DISCOVERY_BROWSER_STORAGE_KEY, JSON.stringify(next)); } catch { setStorageUnavailable(true); }
  }, [commit, stopBrowserWork]);

  const ownsRecord = useCallback(() => {
    if (storageBlocked.current) return false;
    try {
      if (hasNewerDiscoveryBrowserRecord(current.current, window.localStorage.getItem(DISCOVERY_BROWSER_STORAGE_KEY))) {
        storageBlocked.current = true; setNewerRecordAvailable(true); stopBrowserWork(); return false;
      }
    } catch { /* A storage failure does not change ownership of this page. */ }
    return true;
  }, [stopBrowserWork]);

  const connectRun = useCallback(async (runId: string) => {
    const session = current.current.session;
    if (!session) return;
    stream.current?.abort();
    const controller = new AbortController();
    stream.current = controller;
    const generation = ++streamGeneration.current;
    let failures = 0;
    setError("");
    while (!controller.signal.aborted && generation === streamGeneration.current) {
      setConnection(failures ? "reconnecting" : "connecting");
      try {
        const body = await requestJson(`/runs/${encodeURIComponent(runId)}`, { headers: requestHeaders(session.resumeToken), signal: controller.signal });
        const snapshot = discoverySnapshotSchema.parse(body);
        if (snapshot.sessionId !== session.sessionId || snapshot.run?.runId !== runId) throw new Error("这条更新与当前报告不对应。");
        if (controller.signal.aborted || generation !== streamGeneration.current) return;
        installSnapshot(snapshot);
        setError("");
        if (discoveryRunEnded(snapshot.run)) break;
        const after = snapshot.run?.lastSeq ?? 0;
        const response = await fetch(`${API}/runs/${encodeURIComponent(runId)}/events?after=${after}`, { cache: "no-store", headers: requestHeaders(session.resumeToken), signal: controller.signal });
        if (!response.ok) throw new DiscoveryHttpError("报告连接暂时中断，正在重新获取。", response.status);
        setConnection("live");
        setError("");
        await readDiscoveryEventStream(response, frame => {
          if (controller.signal.aborted || generation !== streamGeneration.current) return;
          const event = discoveryEventSchema.parse(JSON.parse(frame.data));
          const before = current.current.snapshot;
          if (!before?.run || before.run.runId !== runId) return;
          const updated = applyDiscoveryEvent(before.run, event);
          if (updated !== before.run) commit(previous => ({ ...previous, snapshot: { ...before, run: updated } }));
          if (event.type === "tool" && event.status === "started") setToolStatus(event.action === "search" ? "正在搜索与推荐有关的资料…" : "正在阅读来源资料…");
          else if (event.type === "text" || event.type === "complete" || event.type === "reset") setToolStatus("");
        }, controller.signal);
        if (controller.signal.aborted) return;
        if (discoveryRunEnded(current.current.snapshot?.run ?? null)) {
          try {
            const final = discoverySnapshotSchema.parse(await requestJson(`/runs/${encodeURIComponent(runId)}`, { headers: requestHeaders(session.resumeToken), signal: controller.signal }));
            if (!controller.signal.aborted) installSnapshot(final);
          } catch { /* The terminal event is already a complete local result. */ }
          break;
        }
        failures = 1;
      } catch (failure) {
        if (controller.signal.aborted || generation !== streamGeneration.current) return;
        failures += 1;
        if (failure instanceof DiscoveryHttpError && [401, 404, 410].includes(failure.status)) {
          const before = current.current;
          commit({ ...emptyDiscoveryBrowserState(), browserRecordId: before.browserRecordId, recordCreatedAt: before.recordCreatedAt });
          setNotice("这次问答与报告已到期或已清除，请重新开始。");
          setError("");
          break;
        }
        setError("连接暂时中断，正在自动恢复。后台任务仍会继续。");
      }
      setConnection("reconnecting");
      await waitBeforeReconnect(Math.min(1000 * 2 ** Math.min(failures - 1, 3), 8000), controller.signal);
    }
    if (generation === streamGeneration.current) { stream.current = null; setConnection("idle"); setToolStatus(""); }
  }, [commit, installSnapshot]);

  const restorePendingReport = useCallback(async () => {
    const before = current.current;
    if (operation.current || !before.session || !ownsRecord()) return;
    const controller = new AbortController();
    operation.current = controller; setBusy(true); setError("");
    try {
      const snapshot = discoverySnapshotSchema.parse(await requestJson("/session", { headers: requestHeaders(before.session.resumeToken), signal: controller.signal }));
      if (controller.signal.aborted || !ownsRecord()) return;
      if (snapshot.sessionId !== before.session.sessionId) throw new Error("恢复的记录与本次问答不对应。");
      if (snapshot.run) {
        installSnapshot(snapshot); saveLocal(); void connectRun(snapshot.run.runId);
      } else if (Date.parse(snapshot.expiresAt) <= Date.now() || Date.parse(before.expiresAt) <= Date.now()) {
        resetLocal("这次问答尚未生成报告且已到期，请重新开始。");
      } else {
        commit(migrateDiscoveryBrowserDraft(before));
        setNotice("已保留上一次草稿，请核对回答后直接生成报告。");
        saveLocal();
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof DiscoveryHttpError && [401, 404, 410].includes(failure.status)) resetLocal("这次问答与报告已到期，请重新开始。");
        else setError(errorMessage(failure));
      }
    }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }, [commit, connectRun, installSnapshot, ownsRecord, resetLocal, saveLocal]);

  const startReport = useCallback(async (newAttempt = false) => {
    if (operation.current || !ownsRecord()) return;
    const before = current.current;
    if (!before.session) { setError("问答会话暂时不可用，请重试提交。"); return; }
    if (discoveryNeedsReportVerification(before)) {
      await restorePendingReport(); return;
    }
    const requestId = !newAttempt && before.reportRequestId ? before.reportRequestId : crypto.randomUUID();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError(""); setToolStatus("");
    try {
      if (controller.signal.aborted || !ownsRecord() || current.current.session?.sessionId !== before.session.sessionId) return;
      stream.current?.abort(); streamGeneration.current += 1;
      commit(previous => ({ ...previous, phase: "report", reportRequestId: requestId,
        session: previous.session ? { ...previous.session, runId: null } : null,
        snapshot: previous.snapshot ? { ...previous.snapshot, run: null } : null,
      }));
      saveLocal();
      const response = await requestJson("/report", { method: "POST", headers: requestHeaders(before.session.resumeToken), signal: controller.signal,
        body: JSON.stringify({ clientRequestId: requestId, ...(before.snapshot?.followups.length ? { followupAnswers: before.snapshot.followupAnswers } : {}) }) });
      if (controller.signal.aborted) return;
      if (typeof response.runId !== "string") throw new Error("暂时没有收到报告任务，请原地重试。");
      const runId = response.runId;
      if (response.snapshot) {
        const snapshot = discoverySnapshotSchema.parse(response.snapshot);
        if (snapshot.sessionId !== before.session.sessionId || snapshot.run?.runId !== runId) throw new Error("报告任务与本次问答不对应。");
        installSnapshot(snapshot);
      }
      commit(previous => ({ ...previous, session: previous.session ? { ...previous.session, runId } : null }));
      saveLocal();
      void connectRun(runId);
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (admissionRejected(failure)) {
          // The server explicitly rejected creation. Keep the answers and any
          // previous failed report; no read-only lost-response check is needed.
          commit(previous => ({ ...previous, reportRequestId: null, session: before.session, snapshot: before.snapshot }));
          saveLocal();
        }
        setError(errorMessage(failure));
      }
    }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }, [commit, connectRun, installSnapshot, ownsRecord, restorePendingReport, saveLocal]);

  const createSession = useCallback(async (submission: DiscoverySubmission) => {
    if (operation.current || !ownsRecord()) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError(""); setNotice("");
    commit(previous => ({ ...previous, phase: "report", submission }));
    saveLocal();
    let nextRunId: string | null = null, shouldStartReport = false;
    try {
      const response = await requestJson("/session", { method: "POST", headers: requestHeaders(), signal: controller.signal, body: JSON.stringify(submission) });
      if (controller.signal.aborted || !ownsRecord()) return;
      if (typeof response.sessionId !== "string" || typeof response.resumeToken !== "string" || typeof response.expiresAt !== "string") throw new Error("暂时没有取得问答会话，请原地重试。");
      const snapshot = discoverySnapshotSchema.parse(response.snapshot);
      if (snapshot.sessionId !== response.sessionId) throw new Error("问答会话与本次提交不对应。");
      nextRunId = snapshot.run?.runId ?? null;
      commit(previous => ({ ...previous, phase: "report", expiresAt: response.expiresAt as string,
        session: { sessionId: response.sessionId as string, resumeToken: response.resumeToken as string, expiresAt: response.expiresAt as string, runId: nextRunId },
        snapshot, followupAnswers: [], followupIndex: 0, followupEditedAt: null, followupSavedAt: null,
      }));
      saveLocal();
      shouldStartReport = !nextRunId;
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (admissionRejected(failure)) {
          commit(previous => ({ ...previous, phase: "review", submission: null }));
          saveLocal();
        }
        setError(errorMessage(failure));
      }
    }
    finally {
      if (operation.current === controller) { operation.current = null; setBusy(false); }
      if (!controller.signal.aborted) {
        if (nextRunId) void connectRun(nextRunId);
        else if (shouldStartReport) void startReport();
      }
    }
  }, [commit, connectRun, ownsRecord, saveLocal, startReport]);

  const submit = useCallback(() => {
    if (operation.current || storageBlocked.current) return;
    const before = current.current;
    try {
      if (hasNewerDiscoveryBrowserRecord(before, window.localStorage.getItem(DISCOVERY_BROWSER_STORAGE_KEY))) { storageBlocked.current = true; setNewerRecordAvailable(true); return; }
    } catch { /* A blocked storage backend does not disable the current page. */ }
    if (before.acceptedConsentVersion !== DISCOVERY_CONSENT_VERSION) { setError("请先阅读并单独同意当前 AI 使用说明。"); return; }
    const firstInvalid = DISCOVERY_QUESTIONS.findIndex(question => !validateDiscoveryStep(question, before.answers).valid);
    if (firstInvalid !== -1) {
      setError("请先完成本回合的每项回答，可以选择选项或自己填写。");
      commit(previous => discoveryDraftChanged(previous, { phase: "questions", questionIndex: firstInvalid }));
      return;
    }
    const parsed = discoverySubmissionSchema.safeParse(before.submission ?? { schemaVersion: DISCOVERY_SCHEMA_VERSION, answers: before.answers, ...(before.additionalText ? { legacyAdditionalText: before.additionalText } : {}),
      consentVersion: DISCOVERY_CONSENT_VERSION, consentAccepted: true, clientRequestId: crypto.randomUUID() });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "请检查问卷回答。"); return; }
    if (!before.submission) commit({ ...before, browserRecordId: crypto.randomUUID(), recordCreatedAt: Math.max(Date.now(), before.recordCreatedAt + 1) });
    void createSession(parsed.data);
  }, [createSession, commit]);

  const clearAll = useCallback(async () => {
    if (storageBlocked.current) return;
    const before = current.current;
    try {
      if (hasNewerDiscoveryBrowserRecord(before, window.localStorage.getItem(DISCOVERY_BROWSER_STORAGE_KEY))) { storageBlocked.current = true; setNewerRecordAvailable(true); stopBrowserWork(); return; }
    } catch { /* Clear the authorized server session even if local storage is unavailable. */ }
    stopBrowserWork(); setBusy(true); setError(""); setDeleteFailed(false);
    try {
      let token = before.session?.resumeToken;
      if (!token && before.submission) {
        const recovered = await requestJson(before.submission.schemaVersion === "competition-discovery.v2" ? "/session?resume=1" : "/clarify?resume=1", { method: "POST", headers: requestHeaders(), body: JSON.stringify(before.submission) });
        if (typeof recovered.resumeToken !== "string") throw new Error("暂时无法确认后台会话。");
        token = recovered.resumeToken;
      }
      if (token) await requestJson("/session", { method: "DELETE", headers: requestHeaders(token) });
      resetLocal("已清除这次问答与报告，可以重新开始。");
    } catch (failure) {
      if (failure instanceof DiscoveryHttpError && [401, 404, 410].includes(failure.status)) {
        resetLocal("这次会话已到期或没有后台记录，已清除本机记录。");
        return;
      }
      setError("暂时未能确认后台停止与删除。可以重试清除，或仅清除当前浏览器中的记录；后台任务可能仍在继续。");
      setDeleteFailed(true);
    } finally { setBusy(false); }
  }, [resetLocal, stopBrowserWork]);
  const cancelRun = useCallback(async () => {
    const before = current.current;
    if (!before.session?.runId || operation.current) return;
    const { session } = before;
    stream.current?.abort(); streamGeneration.current += 1;
    setBusy(true); setError("");
    try {
      await requestJson(`/runs/${encodeURIComponent(session.runId!)}/cancel`, { method: "POST", headers: requestHeaders(session.resumeToken), body: "{}" });
      const snapshot = discoverySnapshotSchema.parse(await requestJson(`/runs/${encodeURIComponent(session.runId!)}`, { headers: requestHeaders(session.resumeToken) }));
      installSnapshot(snapshot); setConnection("idle"); setToolStatus("");
    } catch { setError("尚未确认后台停止，请重试或稍后恢复查看。"); void connectRun(session.runId!); }
    finally { setBusy(false); }
  }, [connectRun, installSnapshot]);

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(DISCOVERY_BROWSER_STORAGE_KEY);
      window.sessionStorage.removeItem("saitu.recommendationRun.v7");
      window.sessionStorage.removeItem("saitu.submissionTiming.v7");
    } catch { setStorageUnavailable(true); }
    const stored = readDiscoveryBrowserState(raw);
    if (stored) commit(stored);
    else if (raw) { try { window.localStorage.removeItem(DISCOVERY_BROWSER_STORAGE_KEY); } catch { /* unavailable */ } setNotice("上一次记录已到期或无法读取，请重新作答。"); }
    setHydrated(true);
    return stopBrowserWork;
  }, [commit, stopBrowserWork]);

  useEffect(() => {
    if (!hydrated) return;
    const restored = current.current;
    if (restored.session?.runId) void connectRun(restored.session.runId);
    else if (restored.phase === "report" && restored.session) void startReport();
    else if (restored.phase === "report" && restored.submission?.schemaVersion === "competition-discovery.v2") void createSession(restored.submission);
  }, [hydrated, createSession, connectRun, startReport]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(saveLocal, 350);
    return () => window.clearTimeout(timer);
  }, [hydrated, state, saveLocal]);
  useEffect(() => {
    if (!hydrated) return;
    const leaving = () => { saveLocal(); };
    window.addEventListener("pagehide", leaving);
    return () => window.removeEventListener("pagehide", leaving);
  }, [hydrated, saveLocal]);
  useEffect(() => {
    if (!hydrated) return;
    const updatedElsewhere = (event: StorageEvent) => {
      if (event.key !== DISCOVERY_BROWSER_STORAGE_KEY || event.newValue !== null && !hasNewerDiscoveryBrowserRecord(current.current, event.newValue)) return;
      storageBlocked.current = true; setNewerRecordAvailable(true); stopBrowserWork();
    };
    window.addEventListener("storage", updatedElsewhere);
    return () => window.removeEventListener("storage", updatedElsewhere);
  }, [hydrated, stopBrowserWork]);
  useEffect(() => {
    if (!hydrated) return;
    // A read-only check may still be in flight, or may need a manual retry after
    // a network error. Do not erase its token using an unverified local expiry.
    if (discoveryNeedsReportVerification(state)) return;
    if (state.session?.runId && !discoveryRunEnded(state.snapshot?.run ?? null)) return;
    const timer = window.setTimeout(() => {
      resetLocal("上一次问答与报告已到期清除，请重新开始。");
    }, Math.max(0, Date.parse(state.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [hydrated, resetLocal, state]);

  const changeAnswer = useCallback((id: DiscoveryFieldId, answer: DiscoveryFieldAnswer) => { setError(""); commit(previous => discoveryDraftChanged(previous, { answers: { ...previous.answers, [id]: answer } })); }, [commit]);
  const removeLegacyText = useCallback(() => { setError(""); commit(previous => discoveryDraftChanged(previous, { additionalText: "" })); }, [commit]);
  const changeConsent = useCallback((accepted: boolean) => commit(previous => discoveryDraftChanged(previous, { acceptedConsentVersion: accepted ? DISCOVERY_CONSENT_VERSION : null })), [commit]);
  const editQuestion = useCallback((index: number) => {
    if (index < 0 || index >= DISCOVERY_QUESTIONS.length) return;
    if (current.current.session || current.current.submission) { setError("这次问答已提交，请清除后重新作答。"); return; }
    setError(""); commit(previous => discoveryDraftChanged(previous, { phase: "questions", questionIndex: index }));
  }, [commit]);
  const nextQuestion = useCallback(() => {
    const before = current.current, validation = validateDiscoveryStep(DISCOVERY_QUESTIONS[before.questionIndex], before.answers);
    if (!validation.valid) { setError(validation.errors[0] ?? "请完成本回合的每项回答。"); return; }
    setError("");
    commit(previous => discoveryDraftChanged(previous, previous.questionIndex === DISCOVERY_QUESTIONS.length - 1 ? { phase: "review" } : { questionIndex: previous.questionIndex + 1 }));
  }, [commit]);
  const previousQuestion = useCallback(() => commit(previous => discoveryDraftChanged(previous, { questionIndex: Math.max(0, previous.questionIndex - 1) })), [commit]);

  return { state, hydrated, busy, error, notice, connection, toolStatus, deleteFailed, storageUnavailable, newerRecordAvailable,
    consentAccepted: state.acceptedConsentVersion === DISCOVERY_CONSENT_VERSION,
    changeAnswer, removeLegacyText, changeConsent, editQuestion, nextQuestion, previousQuestion,
    submit, startReport, cancelRun, clearAll,
    forceLocalClear: () => resetLocal("已清除当前浏览器的记录；后台停止与删除尚未确认，旧任务可能仍在继续。"),
    reconnect: () => { const runId = current.current.session?.runId; if (runId) void connectRun(runId); },
  };
}
