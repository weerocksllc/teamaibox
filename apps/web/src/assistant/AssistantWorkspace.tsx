import {
  AlertTriangle,
  ArrowDownToLine,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Clock3,
  FileOutput,
  Paperclip,
  Link2,
  LoaderCircle,
  MessageSquarePlus,
  Network,
  Plus,
  SendHorizontal,
  Sparkles,
  TerminalSquare,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Locale } from "../i18n";
import { EditorDialog } from "../EditorDialog";
import {
  AssistantApiError,
  cancelAssistantRun,
  createAssistantConversation,
  decideAssistantConfirmation,
  getAssistantConversation,
  listAssistantConversations,
  submitAssistantMessage,
  uploadAssistantInput,
  subscribeAssistantEvents,
  type AssistantConfirmation,
  type AssistantConversation,
  type AssistantConversationSummary,
  type AssistantEvent,
  type AssistantMessage,
  type AssistantMode,
  type AssistantToolCall,
} from "./assistant-client";

type Translator = (key: string, values?: Record<string, string | number>) => string;

function replaceMessage(messages: AssistantMessage[], message: AssistantMessage) {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

function updateRunMessage(messages: AssistantMessage[], runId: string, update: (message: AssistantMessage) => AssistantMessage) {
  return messages.map((message) => message.runId === runId && message.role === "assistant" ? update(message) : message);
}

function reduceAssistantEvent(current: AssistantConversation, event: AssistantEvent): AssistantConversation {
  if (event.sequence <= current.eventCursor) return current;
  let messages = current.messages;
  let confirmations = current.confirmations;
  const message = event.data.message as AssistantMessage | undefined;
  if ((event.type === "message.created" || event.type === "message.completed") && message) {
    messages = replaceMessage(messages, message);
  } else if (event.type === "response.delta") {
    const messageId = String(event.data.messageId ?? "");
    const delta = String(event.data.delta ?? "");
    messages = messages.map((candidate) => candidate.id === messageId
      ? { ...candidate, content: candidate.content + delta }
      : candidate);
  } else if (event.type === "tool.started" || event.type === "tool.completed") {
    const tool = event.data.tool as AssistantToolCall;
    messages = updateRunMessage(messages, event.runId, (candidate) => ({
      ...candidate,
      toolCalls: candidate.toolCalls.some((item) => item.id === tool.id)
        ? candidate.toolCalls.map((item) => item.id === tool.id ? tool : item)
        : [...candidate.toolCalls, tool],
    }));
  } else if (event.type === "artifact.created") {
    const artifact = event.data.artifact as AssistantMessage["artifacts"][number];
    messages = updateRunMessage(messages, event.runId, (candidate) => ({ ...candidate, artifacts: [...candidate.artifacts, artifact] }));
  } else if (event.type === "source.cited") {
    const source = event.data.source as AssistantMessage["sources"][number];
    messages = updateRunMessage(messages, event.runId, (candidate) => ({ ...candidate, sources: [...candidate.sources, source] }));
  } else if (event.type === "usage.updated") {
    const usage = event.data.usage as AssistantMessage["usage"];
    messages = updateRunMessage(messages, event.runId, (candidate) => ({ ...candidate, usage }));
  } else if (event.type === "confirmation.requested") {
    const confirmation = event.data.confirmation as AssistantConfirmation;
    confirmations = [...confirmations.filter((item) => item.id !== confirmation.id), confirmation];
  } else if (event.type === "confirmation.resolved") {
    const confirmation = event.data.confirmation as AssistantConfirmation;
    confirmations = confirmations.map((item) => item.id === confirmation.id ? confirmation : item);
  } else if (event.type === "run.cancelled" || event.type === "run.failed") {
    const status = event.type === "run.cancelled" ? "cancelled" : "failed";
    const error = event.type === "run.failed" ? event.data.error as AssistantMessage["error"] : null;
    messages = updateRunMessage(messages, event.runId, (candidate) => ({ ...candidate, status, error }));
  }
  return { ...current, messages, confirmations, eventCursor: event.sequence };
}

function errorMessage(error: unknown, t: Translator) {
  if (error instanceof AssistantApiError && error.code === "csrf_unavailable") return t("assistant.workspace.session_required");
  if (error instanceof AssistantApiError && error.status === 503) return t("assistant.workspace.unavailable");
  return t("assistant.workspace.error");
}

function OperationConfirmation({ confirmation, locale, t, decide, error }: {
  confirmation: AssistantConfirmation; locale: Locale; t: Translator; error: string | null;
  decide: (confirmation: AssistantConfirmation, decision: "approved" | "denied") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = t(confirmation.titleKey) === confirmation.titleKey ? t("assistant.workspace.confirm_operation") : t(confirmation.titleKey);
  const expiry = t("assistant.workspace.expires", { time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(confirmation.expiresAt)) });
  const submit = async (decision: "approved" | "denied") => {
    setBusy(true);
    try { await decide(confirmation, decision); } finally { setBusy(false); }
  };
  return <article className="assistant-confirmation" role="status">
    <header><span><Clock3 size={17} /></span><div><strong>{title}</strong><small>{expiry}</small></div></header>
    <button type="button" className="secondary-button" onClick={() => setOpen(true)}>{t("assistant.workspace.review_operation")}</button>
    {open && <EditorDialog title={t("assistant.workspace.confirm_title")} description={t("assistant.workspace.confirm_subtitle")} busy={busy} onCancel={() => setOpen(false)} feedback={error}>
      <dl className="assistant-confirmation-fields"><div><dt>{t("assistant.workspace.operation")}</dt><dd>{title}</dd></div>
        {Object.entries(confirmation.scope).map(([key, value]) => <div key={key}><dt>{t(`assistant.scope.${key}`) === `assistant.scope.${key}` ? key : t(`assistant.scope.${key}`)}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</dd></div>)}
      </dl>
      <p className="assistant-confirmation-expiry">{expiry}</p>
      <footer className="assistant-confirmation-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void submit("denied")}>{t("confirmation.deny")}</button><button type="button" className="primary-button" disabled={busy} onClick={() => void submit("approved")}>{t("confirmation.approve")}</button></footer>
    </EditorDialog>}
  </article>;
}

export function AssistantWorkspace({ locale, initialPrompt = "", onClose, t }: {
  locale: Locale;
  initialPrompt?: string;
  onClose: () => void;
  t: Translator;
}) {
  const [conversations, setConversations] = useState<AssistantConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<AssistantConversation | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [mode, setMode] = useState<AssistantMode>("auto");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [streamState, setStreamState] = useState<"connected" | "reconnecting">("reconnecting");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      const list = await listAssistantConversations();
      setConversations(list);
      setActiveId((current) => current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null);
      setPhase("ready");
    } catch (failure) {
      setPhase("error");
      setError(errorMessage(failure, t));
    }
  }, [t]);

  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    if (!activeId) {
      setConversation(null);
      return undefined;
    }
    let active = true;
    let unsubscribe: (() => void) | undefined;
    setError(null);
    void getAssistantConversation(activeId).then((detail) => {
      if (!active) return;
      setConversation(detail);
      unsubscribe = subscribeAssistantEvents({
        conversationId: detail.id,
        afterSequence: detail.eventCursor,
        onConnection: setStreamState,
        onEvent: (event) => setConversation((current) => current ? reduceAssistantEvent(current, event) : current),
      });
    }).catch((failure) => {
      if (active) setError(errorMessage(failure, t));
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [activeId, t]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [conversation?.messages.length, conversation?.messages.at(-1)?.content]);

  const activeRun = useMemo(
    () => [...(conversation?.messages ?? [])].reverse().find((message) => message.role === "assistant" && message.status === "streaming"),
    [conversation?.messages],
  );
  const pendingConfirmations = (conversation?.confirmations ?? []).filter((item) => item.status === "pending");
  // Presentation derived from the existing conversation; no extra artifact requests.
  const resultMessage = [...(conversation?.messages ?? [])].reverse().find(message =>
    message.role === "assistant" && (message.sources.length > 0 || message.artifacts.length > 0));

  const newConversation = async () => {
    setError(null);
    try {
      const created = await createAssistantConversation();
      setConversations((current) => [created, ...current]);
      setConversation(null);
      setActiveId(created.id);
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  const send = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = prompt.trim();
    if (!input || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let conversationId = activeId;
      if (!conversationId) {
        const created = await createAssistantConversation();
        conversationId = created.id;
        setConversations((current) => [created, ...current]);
        setActiveId(created.id);
      }
      setPrompt("");
      const inputReferences: string[] = [];
      // Upload serially so selecting many files does not multiply memory use.
      for (const attachment of attachments) inputReferences.push((await uploadAssistantInput(attachment)).referenceId);
      await submitAssistantMessage(conversationId, input, mode, inputReferences);
      setAttachments([]);
      const detail = await getAssistantConversation(conversationId);
      setConversation(detail);
      setConversations((current) => current.map((item) => item.id === detail.id ? detail : item)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    } catch (failure) {
      setPrompt(input);
      setError(errorMessage(failure, t));
    } finally {
      setSubmitting(false);
    }
  };

  const decide = async (confirmation: AssistantConfirmation, decision: "approved" | "denied") => {
    try {
      const resolved = await decideAssistantConfirmation(confirmation.id, decision);
      setConversation((current) => current ? {
        ...current,
        confirmations: current.confirmations.map((item) => item.id === confirmation.id ? resolved : item),
      } : current);
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  const stop = async () => {
    if (!activeRun) return;
    try {
      await cancelAssistantRun(activeRun.runId);
    } catch (failure) {
      setError(errorMessage(failure, t));
    }
  };

  return (
    <section className="assistant-workspace" role="region" aria-labelledby="assistant-workspace-title">
      <header className="assistant-workspace__header">
        <span className="assistant-workspace__brand"><Bot size={19} aria-hidden="true" /></span>
        <div><p>{t("assistant.workspace.eyebrow")}</p><h2 id="assistant-workspace-title">{t("assistant.workspace.title")}</h2></div>
        <span className={`assistant-connection assistant-connection--${streamState}`}><i />{t(`assistant.workspace.${streamState}`)}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("app.close")}><X size={20} aria-hidden="true" /></button>
      </header>

      <div className="assistant-workspace__body">
        <aside className="assistant-conversation-pane" aria-label={t("assistant.workspace.history")}>
          <button type="button" className="assistant-new-conversation" onClick={() => void newConversation()}>
            <Plus size={16} aria-hidden="true" />{t("assistant.workspace.new_conversation")}
          </button>
          <div className="assistant-conversation-list">
            {conversations.map((item) => (
              <button key={item.id} type="button" className={item.id === activeId ? "is-active" : ""} aria-current={item.id === activeId ? "page" : undefined} onClick={() => setActiveId(item.id)}>
                <MessageSquarePlus size={15} aria-hidden="true" />
                <span><strong>{item.title || t("assistant.workspace.untitled")}</strong><small>{new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.updatedAt))}</small></span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            ))}
          </div>
        </aside>

        <main className="assistant-conversation-main">
          {error && <div className="assistant-error" role="alert"><AlertTriangle size={16} /><span>{error}</span><button type="button" onClick={() => void loadList()}>{t("assistant.workspace.retry")}</button></div>}
          <div className="assistant-transcript" ref={transcriptRef} aria-live="polite">
            {phase === "loading" ? (
              <div className="assistant-empty" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={29} aria-hidden="true" /><h3>{t("assistant.workspace.loading")}</h3></div>
            ) : !conversation || conversation.messages.length === 0 ? (
              <div className="assistant-empty"><span><Sparkles size={27} /></span><h3>{t("assistant.workspace.empty_title")}</h3><p>{t("assistant.workspace.empty_body")}</p></div>
            ) : conversation.messages.map((message) => <AssistantMessageView key={message.id} message={message} locale={locale} t={t} />)}

            {pendingConfirmations.map((confirmation) => (
              <OperationConfirmation key={confirmation.id} confirmation={confirmation} locale={locale} t={t} decide={decide} error={error} />
            ))}
          </div>

          <form className="assistant-workspace__composer" onSubmit={send}>
            <div className="assistant-mode-selector" role="group" aria-label={t("assistant.workspace.mode_label")}>
              {(["auto", "answer", "agent"] as AssistantMode[]).map((item) => <button key={item} type="button" className={mode === item ? "is-selected" : ""} aria-pressed={mode === item} onClick={() => setMode(item)}>{t(`assistant.workspace.mode_${item}`)}</button>)}
            </div>
            <div className="assistant-compose-row">
              <label className="assistant-attach" aria-label={t("assistant.workspace.attach")}><Paperclip size={17} /><input type="file" multiple disabled={submitting} aria-label={t("assistant.workspace.attach")} onChange={(event) => {
                const selected = Array.from(event.target.files ?? []);
                setAttachments((current) => [...current, ...selected]); event.target.value = "";
              }} /></label>
              <textarea aria-label={t("assistant.workspace.composer_label")} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} placeholder={t("assistant.workspace.composer_placeholder")} rows={2} disabled={submitting} />
              {activeRun ? <button type="button" className="assistant-stop" onClick={() => void stop()} aria-label={t("assistant.workspace.stop")}><CircleStop size={18} /></button>
                : <button type="submit" className="assistant-submit" disabled={!prompt.trim() || submitting} aria-label={t("assistant.send")}>{submitting ? <LoaderCircle className="auth-spinner" size={18} /> : <SendHorizontal size={18} />}</button>}
            </div>
            {attachments.map((attachment, index) => <div className="assistant-attachment" key={`${attachment.name}-${attachment.lastModified}-${index}`}><Paperclip size={12} /><span>{attachment.name}</span><button type="button" disabled={submitting} onClick={() => setAttachments((current) => current.filter((_, position) => position !== index))} aria-label={t("assistant.workspace.remove_attachment")}><X size={12} /></button></div>)}
            <small>{t("assistant.workspace.composer_hint")}</small>
          </form>
        </main>
        {resultMessage && <aside className="assistant-result-pane" aria-label={t("assistant.workspace.artifacts")}>
          <h2>{t("assistant.workspace.result_panel")}</h2>
          {resultMessage.artifacts.length > 0 && <section className="assistant-message-links"><h4><FileOutput size={16} />{t("assistant.workspace.artifacts")}</h4>{resultMessage.artifacts.map(artifact => artifact.downloadPath ? <a key={artifact.referenceId} href={artifact.downloadPath}>{artifact.label}<ArrowDownToLine size={16} /></a> : <span key={artifact.referenceId}>{artifact.label}</span>)}</section>}
          {resultMessage.sources.length > 0 && <section className="assistant-message-links"><h4><Link2 size={16} />{t("assistant.workspace.sources")}</h4>{resultMessage.sources.map(source => source.url ? <a key={source.referenceId} href={source.url} target={source.url.startsWith("https://") ? "_blank" : undefined} rel="noreferrer">{source.label}<ChevronRight size={16} /></a> : <span key={source.referenceId}>{source.label}</span>)}</section>}
        </aside>}
      </div>
    </section>
  );
}

function AssistantMessageView({ message, locale, t }: { message: AssistantMessage; locale: Locale; t: Translator }) {
  const assistant = message.role === "assistant";
  const StatusIcon = message.status === "failed" ? XCircle : message.status === "completed" ? CheckCircle2 : LoaderCircle;
  return (
    <article className={`assistant-message assistant-message--${message.role}`}>
      <span className="assistant-message__avatar">{assistant ? <Bot size={17} /> : <UserRound size={17} />}</span>
      <div className="assistant-message__body">
        <header><strong>{t(assistant ? "assistant.workspace.assistant" : "assistant.workspace.you")}</strong><time>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt))}</time>{assistant && <span className={`assistant-message-status assistant-message-status--${message.status}`}><StatusIcon className={message.status === "streaming" ? "auth-spinner" : ""} size={12} />{t(`assistant.workspace.status_${message.status}`)}</span>}</header>
        {assistant && message.routing && <details className="assistant-routing"><summary>{t("assistant.workspace.execution_details")}</summary><div><span><Network size={12} />{t(`assistant.workspace.mode_${message.effectiveMode}`)}</span><span>{message.routing.targetKind === "internal" ? t("assistant.workspace.internal") : t("assistant.workspace.external")}</span><code>{message.routing.modelKey}</code>{message.routing.profileKey && <code>{message.routing.profileKey}</code>}</div></details>}
        <div className="assistant-message__content">{message.content || (message.status === "streaming" ? t("assistant.workspace.thinking") : "")}</div>
        {message.status === "failed" && message.error && <div className="assistant-run-error" role="alert"><AlertTriangle size={14} /><span>{t(message.error.retryable ? "assistant.workspace.run_retryable" : "assistant.workspace.run_failed")}</span><code>{message.error.code}</code></div>}
        {message.toolCalls.length > 0 && <section className="assistant-tools"><h4><TerminalSquare size={14} />{t("assistant.workspace.tools")}</h4>{message.toolCalls.map((tool) => <div key={tool.id}><span className={`tool-state tool-state--${tool.status}`} /> <strong>{tool.name}</strong><small>{tool.summary}</small></div>)}</section>}
        {message.sources.length > 0 && <section className="assistant-message-links"><h4><Link2 size={14} />{t("assistant.workspace.sources")}</h4>{message.sources.map((source) => source.url ? <a key={source.referenceId} href={source.url} target={source.url.startsWith("https://") ? "_blank" : undefined} rel="noreferrer">{source.label}<ChevronRight size={13} /></a> : <span key={source.referenceId}>{source.label}</span>)}</section>}
        {message.artifacts.length > 0 && <section className="assistant-message-links"><h4><FileOutput size={14} />{t("assistant.workspace.artifacts")}</h4>{message.artifacts.map((artifact) => artifact.downloadPath ? <a key={artifact.referenceId} href={artifact.downloadPath}>{artifact.label}<ArrowDownToLine size={13} /></a> : <span key={artifact.referenceId}>{artifact.label}</span>)}</section>}
        {message.usage && <footer className="assistant-usage">{t("assistant.workspace.usage", { input: message.usage.inputTokens, output: message.usage.outputTokens })}{message.usage.costMicrounits > 0 && ` · ${t("assistant.workspace.cost", { cost: (message.usage.costMicrounits / 1_000_000).toFixed(4), currency: message.usage.currency })}`}</footer>}
      </div>
    </article>
  );
}
