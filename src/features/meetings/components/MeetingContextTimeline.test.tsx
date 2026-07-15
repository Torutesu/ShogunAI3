import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MeetingContextTimeline } from './MeetingContextTimeline';

describe('MeetingContextTimeline', () => {
  it('renders capture and transcript actions and invokes callbacks', () => {
    const onOpenMemory = vi.fn();
    const onAskChat = vi.fn();
    const onOpenMeetingContext = vi.fn();
    const onOpenMeetingActions = vi.fn();

    render(
      <MeetingContextTimeline
        items={[
          {
            kind: 'capture',
            memory_id: 'mem-1',
            offset_label: '00:12',
            title: 'Figma board',
            text: 'Security review checklist',
          },
          {
            kind: 'transcript',
            offset_label: '00:18',
            speaker: 'Mio',
            text: 'We should send the follow-up today.',
          },
        ]}
        onOpenMemory={onOpenMemory}
        onOpenMeetingContext={onOpenMeetingContext}
        onOpenMeetingActions={onOpenMeetingActions}
        onAskChat={onAskChat}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Memory' }));
    expect(onOpenMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capture',
        memory_id: 'mem-1',
      }),
    );

    const askButtons = screen.getAllByRole('button', { name: 'Ask Chat' });
    expect(askButtons).toHaveLength(2);
    const contextButtons = screen.getAllByRole('button', { name: 'Open Meeting Detail' });
    const actionButtons = screen.getAllByRole('button', { name: 'Actions' });
    expect(contextButtons).toHaveLength(2);
    expect(actionButtons).toHaveLength(2);

    fireEvent.click(contextButtons[0]!);
    fireEvent.click(actionButtons[1]!);

    fireEvent.click(askButtons[0]!);
    fireEvent.click(askButtons[1]!);

    expect(onAskChat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: 'capture',
        text: 'Security review checklist',
      }),
    );
    expect(onAskChat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 'transcript',
        speaker: 'Mio',
      }),
    );
    expect(onOpenMeetingContext).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capture',
        memory_id: 'mem-1',
      }),
    );
    expect(onOpenMeetingActions).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'transcript',
        speaker: 'Mio',
      }),
    );
  });
});
