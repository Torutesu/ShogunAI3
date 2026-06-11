import React from 'react';
import { Kamon, Icon } from '@/shared/icons';
import {
  formatMeetingTimeLabel,
  meetingProviderLabel,
  type MeetingDetectDetail,
} from '@/shared/lib/meeting-detect-events';

export interface MeetingPromptBannerProps {
  prompt: MeetingDetectDetail | null;
  onTakeNotes: () => void;
  onDismiss: () => void;
}

export function MeetingPromptBanner({
  prompt,
  onTakeNotes,
  onDismiss,
}: MeetingPromptBannerProps): React.ReactElement | null {
  if (!prompt) return null;

  const timeLabel = formatMeetingTimeLabel(prompt);
  const subtitle = meetingProviderLabel(prompt.provider);

  return (
    <div className="shogun-meeting-prompt-host" role="dialog" aria-label="Meeting detected">
      <div className="shogun-meeting-prompt">
        <div className="shogun-meeting-prompt-accent" aria-hidden="true" />
        <div className="shogun-meeting-prompt-info">
          <div className="shogun-meeting-prompt-title">{prompt.title || 'Meeting'}</div>
          <div className="shogun-meeting-prompt-meta">
            {timeLabel}
            {subtitle ? ` · ${subtitle}` : ''}
          </div>
        </div>
        <button type="button" className="shogun-meeting-prompt-action" onClick={onTakeNotes}>
          <span className="shogun-meeting-prompt-action-icon" aria-hidden="true">
            <Kamon size={16} />
          </span>
          <span className="shogun-meeting-prompt-action-label">議事録を取る</span>
          <Icon name="chevronDown" size={12} className="shogun-meeting-prompt-action-chevron" />
        </button>
        <button
          type="button"
          className="shogun-meeting-prompt-close"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="後で"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
