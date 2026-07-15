import { describe, expect, it, vi } from 'vitest';

import {
  buildActionChatSeed,
  buildDraftChatSeed,
  buildEntityChatSeed,
  buildFieldChatSeed,
  buildMeetingChatSeed,
  openChatWithSeed,
} from './chat-composer-seed';

describe('chat-composer-seed builders', () => {
  it('builds an entity chat seed with rollup and top signals', () => {
    const result = buildEntityChatSeed({
      entityId: 'company:aurora',
      entityLabel: 'aurora · company',
      rollupTitle: 'Aurora beta timeline',
      fieldLabel: 'next_action = Send security follow-up',
      actionLabel: 'Draft follow-up [proposed]',
    });

    expect(result.memoryAssemblyQuery).toBe('company:aurora');
    expect(result.assembleMemory).toBe(true);
    expect(result.text).toContain('aurora · company (company:aurora)');
    expect(result.text).toContain('Rollup: Aurora beta timeline');
    expect(result.text).toContain('Field: next_action = Send security follow-up');
    expect(result.text).toContain('Action: Draft follow-up [proposed]');
  });

  it('builds a field chat seed with evidence ids', () => {
    const result = buildFieldChatSeed({
      ownerEntityId: 'company:aurora',
      fieldName: 'next_action',
      currentValue: 'Send security follow-up',
      instruction: 'Track the next action.',
      evidenceIds: ['meeting:aurora-beta'],
    });

    expect(result.memoryAssemblyQuery).toBe('company:aurora');
    expect(result.text).toContain('Field: next_action');
    expect(result.text).toContain('Current value: Send security follow-up');
    expect(result.text).toContain('Evidence: meeting:aurora-beta');
  });

  it('builds an action chat seed with review context', () => {
    const result = buildActionChatSeed({
      ownerEntityId: 'company:aurora',
      title: 'Draft follow-up',
      actionType: 'follow_up_email_draft',
      status: 'proposed',
      riskLevel: 'medium',
      detail: 'Need answers for security review.',
    });

    expect(result.memoryAssemblyQuery).toBe('company:aurora');
    expect(result.text).toContain('Action: Draft follow-up');
    expect(result.text).toContain('Type: follow_up_email_draft');
    expect(result.text).toContain('Status: proposed');
    expect(result.text).toContain('Risk: medium');
    expect(result.text).toContain('Detail: Need answers for security review.');
  });

  it('builds a draft chat seed with the generated draft body', () => {
    const result = buildDraftChatSeed({
      ownerEntityId: 'company:aurora',
      title: 'Draft security follow-up',
      actionType: 'follow_up_email_draft',
      detail: 'Need answers for security review.',
      draftContent: '# Draft\n\nSubject: Follow-up\n\nPlease review the security timeline.',
    });

    expect(result.memoryAssemblyQuery).toBe('company:aurora');
    expect(result.newChat).toBe(true);
    expect(result.text).toContain('Action: Draft security follow-up');
    expect(result.text).toContain('Type: follow_up_email_draft');
    expect(result.text).toContain('Draft:');
    expect(result.text).toContain('Subject: Follow-up');
  });

  it('builds a meeting chat seed with transcript context', () => {
    const result = buildMeetingChatSeed({
      meetingId: 'mtg-aurora-1',
      title: 'Aurora weekly sync',
      startedAt: Date.UTC(2026, 5, 28, 1, 30),
      speakerCount: 3,
      segmentCount: 12,
      transcriptSnippet: 'CEO: We need the security follow-up.\nPM: I will draft it today.',
      noteSnippet: 'Open issue: SOC2 docs still missing.',
      question: 'What should we do next?',
    });

    expect(result.memoryAssemblyQuery).toBe('meeting:mtg-aurora-1');
    expect(result.text).toContain('Aurora weekly sync (mtg-aurora-1)');
    expect(result.text).toContain('Question: What should we do next?');
    expect(result.text).toContain('Speakers: 3');
    expect(result.text).toContain('Segments: 12');
    expect(result.text).toContain('Transcript snippet:');
    expect(result.text).toContain('CEO: We need the security follow-up.');
    expect(result.text).toContain('Note snippet:');
    expect(result.text).toContain('Open issue: SOC2 docs still missing.');
  });

  it('dispatches a composer seed with memory preset and creates a new chat when requested', async () => {
    const setActiveScreen = vi.fn();
    const createNewChat = vi.fn();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen, createNewChat };

    const detail = await new Promise<Record<string, unknown>>((resolve) => {
      const onSeed = (event: Event) => {
        window.removeEventListener('shogun-chat-composer-seed', onSeed);
        resolve((event as CustomEvent<Record<string, unknown>>).detail);
      };
      window.addEventListener('shogun-chat-composer-seed', onSeed);
      openChatWithSeed({
        text: '  summarize this  ',
        newChat: true,
        memoryAssemblyQuery: 'company:aurora',
        memoryAssemblyLimit: 120,
      });
    });

    expect(createNewChat).toHaveBeenCalledTimes(1);
    expect(setActiveScreen).toHaveBeenCalledWith('chat');
    expect(detail.text).toBe('summarize this');
    expect(detail.assembleMemory).toBe(true);
    expect(detail.memoryAssemblyPreset).toEqual({
      query: 'company:aurora',
      limit: 80,
      semantic: true,
    });
  });
});
