import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';

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

export function HummingbirdOverlay(props: HummingbirdOverlayProps) {
  if (!props.open) return null;
  const ja = props.language === 'jp';

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
          <h2 id="hummingbird-title" className="hummingbird-title">
            <span className="en-only">Today&apos;s Priorities</span>
            <span className="jp">今日の優先</span>
          </h2>
          <span className="hummingbird-actions-hint t-mono">
            <span className="en-only">Actions</span>
            <span className="jp">操作</span>
            {' '}
            <span className="kbd">⌘K</span>
          </span>
        </div>
        <div className="hummingbird-scroll">
          <p className="hummingbird-p">
            <span className="en-only">
              Data backup deadlines and plan reviews are coming up—block time on your calendar so nothing slips.
            </span>
            <span className="jp">
              データバックアップの期限やプラン確認が近づいています。カレンダーに時間を確保して取りこぼしを防ぎましょう。
            </span>
          </p>
          <ul className="hummingbird-ul">
            <li>
              <strong>求人・案件情報:</strong>{' '}
              <span className="en-only">
                AI lead engineer roles and executive positions surfaced on LinkedIn and YOUTRUST—worth a skim.
              </span>
              <span className="jp">
                LinkedIn や YOUTRUST で AI リードエンジニアや役員クラスの求人が目立ちます。ざっと確認する価値ありです。
              </span>
            </li>
          </ul>
          <hr className="hummingbird-rule" />
          <p className="hummingbird-p">
            <strong>Hummingbirdからの提案:</strong>
          </p>
          <p className="hummingbird-p">
            <span className="en-only">
              From your calendar, the <strong>15:00</strong> slot lines up with a match—consider pairing it with light technical
              research into <strong>Lovable</strong> or <strong>Railway</strong> for the <strong>SHOGUN</strong> build.
            </span>
            <span className="jp">
              カレンダーでは <strong>15時</strong> 前後が空いています。{' '}
              <strong>SHOGUN</strong> 向けに <strong>Lovable</strong> や <strong>Railway</strong> の技術調査を軽く挟むのはどうでしょう。
            </span>
          </p>
          <p className="hummingbird-p hummingbird-muted">
            <span className="en-only">Are there any specific tasks you want to proceed with first?</span>
            <span className="jp">まず手を付けたいタスクはありますか？</span>
          </p>
        </div>
        <div className="hummingbird-feedback">
          <button
            type="button"
            className="hummingbird-icon-btn"
            title="Copy"
            aria-label="Copy"
            onClick={() => {
              const text = ja
                ? [
                    'データバックアップの期限やプラン確認が近づいています。',
                    '',
                    '求人・案件情報: LinkedIn や YOUTRUST で AI リードエンジニアや役員クラスの求人が目立ちます。',
                    '',
                    'Hummingbirdからの提案: カレンダーでは 15時 前後が空いています。SHOGUN 向けに Lovable や Railway の技術調査を軽く挟むのはどうでしょう。',
                    '',
                    'まず手を付けたいタスクはありますか？',
                  ].join('\n')
                : [
                    'Data backup deadlines and plan reviews are coming up.',
                    '',
                    'Job leads: AI lead engineer and executive roles on LinkedIn and YOUTRUST.',
                    '',
                    'Hummingbird proposal: the 15:00 slot fits—consider research into Lovable or Railway for SHOGUN.',
                    '',
                    'Any specific tasks you want to proceed with first?',
                  ].join('\n');
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
          <button type="button" className="hummingbird-icon-btn" title="Good response" aria-label="Good response">
            <Icon name="thumbsUp" size={15} />
          </button>
          <button
            type="button"
            className="hummingbird-icon-btn"
            title="Bad response"
            aria-label="Bad response"
            onClick={() => {
              const assistantText = ja
                ? [
                    'データバックアップの期限やプラン確認が近づいています。カレンダーに時間を確保して取りこぼしを防ぎましょう。',
                    '',
                    '求人・案件情報: LinkedIn や YOUTRUST で AI リードエンジニアや役員クラスの求人が目立ちます。ざっと確認する価値ありです。',
                    '',
                    'Hummingbirdからの提案: カレンダーでは 15時 前後が空いています。SHOGUN 向けに Lovable や Railway の技術調査を軽く挟むのはどうでしょう。',
                    '',
                    'まず手を付けたいタスクはありますか？',
                  ].join('\n')
                : [
                    'Data backup deadlines and plan reviews are coming up.',
                    '',
                    'Job leads: AI lead engineer and executive roles on LinkedIn and YOUTRUST.',
                    '',
                    'Hummingbird proposal: the 15:00 slot fits—consider research into Lovable or Railway for SHOGUN.',
                    '',
                    'Any specific tasks you want to proceed with first?',
                  ].join('\n');
              const userText = ja ? '今日の優先事項を教えて' : "What are today's priorities?";
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
                if ((props.input || '').trim()) {
                  props.pushToast(ja ? '送信（プレビュー）' : 'Send (preview)', 'info');
                  props.onInputChange('');
                }
              }
            }}
            aria-label="Ask Hummingbird"
          />
          <button
            type="button"
            className="hummingbird-send"
            aria-label="Send"
            onClick={() => {
              if ((props.input || '').trim()) {
                props.pushToast(ja ? '送信（プレビュー）' : 'Send (preview)', 'info');
                props.onInputChange('');
              }
            }}
          >
            <Icon name="arrowUp" size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
