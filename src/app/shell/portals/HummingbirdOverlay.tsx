import { useEffect, useMemo, useState } from 'react';
import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';

type HummingbirdMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type HummingbirdContextAudit = {
  frontmostApp: string | null;
  frontmostBundleId: string | null;
  frontmostWindowTitle: string | null;
  axSnapshotSource: string | null;
  axTextSignalQuality: string | null;
  axTextSignalKeys: string[];
  axTextChars: number | null;
};

type HummingbirdResponseAudit = {
  liveScreenContextIncluded: boolean | null;
  liveScreenContextChars: number | null;
  memoryHits: number | null;
};

export interface HummingbirdOverlayProps {
  open: boolean;
  language: string;
  input: string;
  activeChat: any;
  onClose: () => void;
  onInputChange: (value: string) => void;
  pushToast: (message: string, kind: string) => void;
  executeAction: (actionKey: string, payload: any, options?: any) => Promise<any>;
}

function latestByRole(messages: HummingbirdMessage[], role: HummingbirdMessage['role']): string {
  return [...messages].reverse().find((message) => message.role === role)?.content || '';
}

function contextAuditFromPayload(data: any): HummingbirdContextAudit | null {
  if (!data || typeof data !== 'object') return null;
  const keys = Array.isArray(data.axTextSignalKeys)
    ? data.axTextSignalKeys.filter((key: unknown) => typeof key === 'string' && key.trim())
    : [];
  return {
    frontmostApp: typeof data.frontmostApp === 'string' ? data.frontmostApp : null,
    frontmostBundleId: typeof data.frontmostBundleId === 'string' ? data.frontmostBundleId : null,
    frontmostWindowTitle: typeof data.frontmostWindowTitle === 'string' ? data.frontmostWindowTitle : null,
    axSnapshotSource: typeof data.axSnapshotSource === 'string' ? data.axSnapshotSource : null,
    axTextSignalQuality: typeof data.axTextSignalQuality === 'string' ? data.axTextSignalQuality : null,
    axTextSignalKeys: keys,
    axTextChars: typeof data.axTextChars === 'number' ? data.axTextChars : null,
  };
}

function contextStatusLabel(audit: HummingbirdContextAudit | null, loading: boolean, ja: boolean): string {
  if (loading) return ja ? '確認中' : 'Checking';
  if (!audit) return ja ? '文脈未取得' : 'Context pending';
  const quality = audit.axTextSignalQuality || 'unknown';
  const app = audit.frontmostApp || 'unknown';
  return `${app} · ${quality}`;
}

function responseAuditFromPayload(data: any): HummingbirdResponseAudit {
  const memoryTotal = data && typeof data === 'object' && data.memoryAssembly && typeof data.memoryAssembly.total === 'number'
    ? data.memoryAssembly.total
    : null;
  return {
    liveScreenContextIncluded: data && typeof data === 'object' && typeof data.liveScreenContextIncluded === 'boolean'
      ? data.liveScreenContextIncluded
      : null,
    liveScreenContextChars: data && typeof data === 'object' && typeof data.liveScreenContextChars === 'number'
      ? data.liveScreenContextChars
      : null,
    memoryHits: memoryTotal,
  };
}

function responseAuditLabel(audit: HummingbirdResponseAudit | null, ja: boolean): string | null {
  if (!audit) return null;
  const screen = audit.liveScreenContextIncluded === true
    ? `${ja ? '画面文脈' : 'Screen context'} ${audit.liveScreenContextChars ?? 0} chars`
    : audit.liveScreenContextIncluded === false
      ? (ja ? '画面文脈なし' : 'No screen context attached')
      : (ja ? '画面文脈は未確認' : 'Screen context not reported');
  const memory = audit.memoryHits != null
    ? `${ja ? 'Memory' : 'Memory'} ${audit.memoryHits} hits`
    : null;
  return memory ? `${screen} · ${memory}` : screen;
}

export function HummingbirdOverlay(props: HummingbirdOverlayProps) {
  const { executeAction, open } = props;
  const ja = props.language === 'jp';
  const [messages, setMessages] = useState<HummingbirdMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [contextAudit, setContextAudit] = useState<HummingbirdContextAudit | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [responseAudit, setResponseAudit] = useState<HummingbirdResponseAudit | null>(null);
  const latestAssistantText = useMemo(() => latestByRole(messages, 'assistant'), [messages]);
  const latestUserText = useMemo(() => latestByRole(messages, 'user'), [messages]);
  const statusLabel = contextStatusLabel(contextAudit, contextLoading, ja);
  const responseAuditText = responseAuditLabel(responseAudit, ja);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setContextLoading(true);
    executeAction('hummingbird.context', { source: 'overlay' }, { silentError: true })
      .then((res) => {
        if (cancelled) return;
        setContextAudit(res?.ok ? contextAuditFromPayload(res.data) : null);
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [executeAction, open]);

  const send = async () => {
    const text = (props.input || '').trim();
    if (!text || loading) return;
    const userTurn: HummingbirdMessage = { role: 'user', content: text };
    const next = messages.concat(userTurn);
    setMessages(next);
    setResponseAudit(null);
    props.onInputChange('');
    setLoading(true);
    const res = await props.executeAction('chat.complete', {
      messages: next,
      includeScreenContext: true,
      hummingbirdContextAudit: contextAudit,
      memoryAssembly: {
        query: text.slice(0, 480),
        limit: 12,
        semantic: true,
      },
    }, { silentError: true });
    setLoading(false);
    if (!res?.ok) {
      props.pushToast(res?.error?.message || (ja ? 'Hummingbird の送信に失敗しました' : 'Hummingbird request failed'), 'error');
      return;
    }
    const reply = typeof res.data?.message === 'string' ? res.data.message.trim() : '';
    if (!reply) {
      props.pushToast(ja ? '空の応答でした' : 'Empty response', 'warn');
      return;
    }
    setResponseAudit(responseAuditFromPayload(res.data));
    setMessages((prev) => prev.concat({ role: 'assistant', content: reply }));
  };

  if (!props.open) return null;

  return ReactDOM.createPortal(
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1130,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        background: 'rgba(10, 9, 8, 0.58)',
        boxSizing: 'border-box',
      }}
      onMouseDown={props.onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hummingbird-title"
        className="hummingbird-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="hummingbird-panel-head">
          <button
            type="button"
            className="hummingbird-close"
            aria-label="Close"
            onClick={props.onClose}
          >
            <Icon name="x" size={16} />
          </button>
          <h2 id="hummingbird-title" className="hummingbird-title">Hummingbird</h2>
          <span className="hummingbird-actions-hint t-mono">
            {loading ? (ja ? '考え中' : 'Thinking') : statusLabel}
          </span>
        </div>
        <div className="hummingbird-scroll">
          {messages.length === 0 ? (
            <p className="hummingbird-p hummingbird-muted">
              {contextAudit?.frontmostWindowTitle || contextAudit?.frontmostApp || (ja ? '現在の画面' : 'Current screen')}
            </p>
          ) : null}
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              style={{
                marginBottom: 14,
                display: 'flex',
                justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                className="hummingbird-p"
                style={{
                  margin: 0,
                  maxWidth: message.role === 'user' ? '82%' : '100%',
                  whiteSpace: 'pre-wrap',
                  color: message.role === 'user' ? 'rgba(255,255,255,0.9)' : undefined,
                  background: message.role === 'user' ? 'rgba(255,255,255,0.08)' : 'transparent',
                  border: message.role === 'user' ? '1px solid rgba(255,255,255,0.1)' : 'none',
                  borderRadius: message.role === 'user' ? 8 : 0,
                  padding: message.role === 'user' ? '10px 12px' : 0,
                }}
              >
                {message.content}
              </div>
            </div>
          ))}
          {loading ? (
            <p className="hummingbird-p hummingbird-muted">
              {ja ? '現在の画面テキストと Memory を見ながら考えています。' : 'Reading the current screen text and Memory context.'}
            </p>
          ) : null}
          {!loading && responseAuditText ? (
            <p
              className="hummingbird-p hummingbird-muted"
              style={{
                borderTop: '1px solid rgba(255,255,255,0.08)',
                marginTop: 4,
                paddingTop: 10,
              }}
            >
              {responseAuditText}
            </p>
          ) : null}
        </div>
        <div className="hummingbird-feedback">
          <button
            type="button"
            className="hummingbird-icon-btn"
            title="Copy"
            aria-label="Copy"
            disabled={!latestAssistantText}
            onClick={() => {
              const text = latestAssistantText;
              if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(
                  () => props.pushToast(ja ? 'コピーしました' : 'Copied', 'success'),
                  () => props.pushToast(ja ? 'コピーに失敗しました' : 'Copy failed', 'error'),
                );
              }
            }}
          >
            <Icon name="copy" size={15} />
          </button>
          <button
            type="button"
            className="hummingbird-icon-btn"
            title="Good response"
            aria-label="Good response"
            disabled={!latestAssistantText}
            onClick={() => props.pushToast(ja ? 'フィードバックを記録しました' : 'Feedback noted', 'success')}
          >
            <Icon name="thumbsUp" size={15} />
          </button>
          <button
            type="button"
            className="hummingbird-icon-btn"
            title="Bad response"
            aria-label="Bad response"
            disabled={!latestAssistantText}
            onClick={() => {
              const assistantText = latestAssistantText;
              const userText = latestUserText || (ja ? '今日の優先事項を教えて' : "What are today's priorities?");
              if (!assistantText || !userText) return;
              props.executeAction('lesson.capture.rejection', {
                userMsg: userText,
                assistantMsg: assistantText,
                chatId: props.activeChat || undefined,
              }, { silentError: true, successMessage: "Got it — won't do that again." });
            }}
          >
            <Icon name="thumbsDown" size={15} />
          </button>
        </div>
        <div className="hummingbird-composer">
          <input
            type="text"
            className="hummingbird-input"
            placeholder="Ask anything…"
            value={props.input}
            onChange={(e) => props.onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                send();
              }
            }}
            aria-label="Ask Hummingbird"
            disabled={loading}
          />
          <button
            type="button"
            className="hummingbird-send"
            aria-label="Send"
            disabled={loading || !(props.input || '').trim()}
            onClick={send}
          >
            <Icon name="arrowUp" size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
