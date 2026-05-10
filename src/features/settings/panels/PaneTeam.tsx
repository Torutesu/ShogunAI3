import React, { useState } from 'react';
import { Icon } from '@/shared/icons';
import { Pane } from '../components/Pane';
import { useRuntimeActions } from '../lib/hooks';
import { PRODUCT } from '../lib/defaults';

export function PaneTeam() {
  const { toast } = useRuntimeActions();
  const [size, setSize] = useState('');
  const [purpose, setPurpose] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);

  const canSend = size.trim().length > 0 && purpose.trim().length > 0;

  const sendFeedback = React.useCallback(() => {
    if (!canSend || sending) return;
    setSending(true);
    try {
      const recipient = (PRODUCT.supportMailto || '').replace(/^mailto:/, '').split('?')[0] || 'support@yourcompany.com';
      const subject = 'SHOGUN for Teams — Feedback / フィードバック';
      const bodyLines = [
        'Team size / チーム規模:',
        size.trim(),
        '',
        'What you would use it for / 用途:',
        purpose.trim(),
      ];
      if (email.trim()) {
        bodyLines.push('', 'Reply to / 返信先:', email.trim());
      }
      const href = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines.join('\n'))}`;
      if (typeof window !== 'undefined') {
        window.location.href = href;
      }
      toast('Thanks! / ありがとうございます', 'info');
      setSize('');
      setPurpose('');
      setEmail('');
    } finally {
      setSending(false);
    }
  }, [canSend, sending, size, purpose, email, toast]);

  return (
    <Pane title="Team" jp="組">
      <div className="s-card" style={{ padding: 20 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            border: '1px solid var(--gold-dim)', color: 'var(--gold)',
            fontSize: 11, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>
            <span className="en-only">Coming Soon</span>
            <span className="jp">近日公開</span>
          </span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 500 }}>
          SHOGUN for Teams
          <span className="jp dim" style={{ fontSize: 11, marginLeft: 6 }}>組織版</span>
        </div>
        <div className="s-field-hint" style={{ marginTop: 6 }}>
          <span className="en-only">Team features are in development. Tell us what you need and we&apos;ll prioritize.</span>
          <span className="jp">チーム機能は開発中です。必要な内容を教えていただけると優先度を決める参考になります。</span>
        </div>
        <div className="s-field-hint" style={{ marginTop: 12, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          <span className="en-only">Planned</span>
          <span className="jp">予定機能</span>
        </div>
        <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', fontSize: 13, lineHeight: 2 }}>
          {[
            'Centralized billing for your company',
            'Invite and manage team members',
            'Mix Plus and Pro seats in one team',
          ].map(f => (
            <li key={f}><span style={{ marginRight: 8, display: 'inline-block' }}><Icon name="check" size={11} className="gold" /></span>{f}</li>
          ))}
        </ul>
      </div>

      <div className="s-card" style={{ padding: 20, marginTop: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>
          <span className="en-only">Send us feedback</span>
          <span className="jp">フィードバックを送る</span>
        </div>
        <div className="s-field-hint" style={{ marginTop: 4 }}>
          <span className="en-only">Two quick questions — this helps us ship the right thing first.</span>
          <span className="jp">2問だけ。優先順位付けに役立てます。</span>
        </div>

        <div style={{ marginTop: 14 }}>
          <label className="s-field-hint" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>
            <span className="en-only">Team size (e.g. 5, 20, 100+)</span>
            <span className="jp">チーム規模（例: 5人 / 20人 / 100人以上）</span>
          </label>
          <input
            className="s-input"
            type="text"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="e.g. 20 / 20人"
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <label className="s-field-hint" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>
            <span className="en-only">What would you use SHOGUN for Teams for?</span>
            <span className="jp">どんな用途で使いたいですか？</span>
          </label>
          <textarea
            className="s-input"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={4}
            placeholder="e.g. Share prompts across our sales org / 営業部門でプロンプトを共有したい"
            style={{ width: '100%', resize: 'vertical', minHeight: 90, fontFamily: 'inherit' }}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <label className="s-field-hint" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>
            <span className="en-only">Email (optional — for replies)</span>
            <span className="jp">メール（任意・返信希望の場合）</span>
          </label>
          <input
            className="s-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            style={{ width: '100%' }}
          />
        </div>

        <div className="row" style={{ marginTop: 16, gap: 12, alignItems: 'center' }}>
          <button
            className="btn btn-secondary"
            onClick={sendFeedback}
            disabled={!canSend || sending}
            style={!canSend || sending ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
          >
            <span className="en-only">Send feedback</span>
            <span className="jp">送信</span>
          </button>
          <span className="s-field-hint" style={{ fontSize: 11 }}>
            <span className="en-only">Opens your mail app to deliver the message.</span>
            <span className="jp">メールアプリが起動して送信されます。</span>
          </span>
        </div>
      </div>
    </Pane>
  );
}
