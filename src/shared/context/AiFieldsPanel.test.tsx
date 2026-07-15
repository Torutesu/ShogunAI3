import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiFieldsPanel } from './AiFieldsPanel';
import { ACTION_LAYER_REFRESH_EVENT } from './action-layer-events';

const runRuntimeActionMock = vi.fn();
const openEvidenceReferenceMock = vi.fn();
const nativeDetailDescriptorForEntityIdMock = vi.fn((entityId: string) => {
  const normalized = String(entityId || '').trim();
  if (normalized.startsWith('meeting:')) {
    return { kind: 'meeting', id: normalized.slice('meeting:'.length), label: 'Open Meeting Detail' };
  }
  if (normalized.startsWith('workspace:')) {
    return { kind: 'workspace', id: normalized.slice('workspace:'.length), label: 'Open Workspace Detail' };
  }
  return null;
});
const openNativeDetailForEntityIdMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('./context-target-navigation', () => ({
  openEvidenceReference: (...args: unknown[]) => openEvidenceReferenceMock(...args),
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

describe('AiFieldsPanel', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    openEvidenceReferenceMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openNativeDetailForEntityIdMock.mockReset();
  });

  it('opens evidence references from AI field previews', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'field-1',
                ownerEntityId: 'company:aurora',
                fieldName: 'blocker',
                instruction: 'Track the security blocker.',
                currentValue: 'Security questionnaire pending',
                confidence: 0.81,
                evidenceEventIds: ['mem-1'],
              },
            ],
          },
        });
      }
      if (actionKey === 'memory.fetch') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'mem-1',
                title: 'Aurora security note',
                snippet: 'Questionnaire still pending.',
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<AiFieldsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Security questionnaire pending')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'open mem-1' }));
    expect(openEvidenceReferenceMock).toHaveBeenCalledWith({
      id: 'mem-1',
      title: 'Security questionnaire pending',
    });

    await waitFor(() => {
      expect(screen.getByText('Aurora security note')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Aurora security note').closest('button') as HTMLButtonElement);
    expect(openEvidenceReferenceMock).toHaveBeenCalledWith({
      id: 'mem-1',
      title: 'Aurora security note',
    });
  });

  it('shows native detail CTA for meeting evidence previews', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'field-1',
                ownerEntityId: 'company:aurora',
                fieldName: 'blocker',
                instruction: 'Track the security blocker.',
                currentValue: 'Security questionnaire pending',
                confidence: 0.81,
                evidenceEventIds: ['meeting:mtg-1'],
              },
            ],
          },
        });
      }
      if (actionKey === 'meetings.get') {
        return Promise.resolve({
          ok: true,
          data: {
            meeting: { title: 'Aurora sync' },
            transcript: [{ text: 'Security concerns still open.' }],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<AiFieldsPanel />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Open Meeting Detail' }).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Open Meeting Detail' })[0] as HTMLButtonElement);
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-1');
  });

  it('dispatches a shared refresh event after saving an AI field', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'ai_field.upsert') {
        return Promise.resolve({
          ok: true,
          data: {
            id: 'field-new',
            ownerEntityId: 'company:aurora',
            fieldName: 'blocker',
            instruction: 'Track the security blocker.',
            currentValue: 'Security questionnaire pending',
            confidence: 0.81,
            evidenceEventIds: ['mem-1'],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    const refreshSpy = vi.fn();
    const pushToast = vi.fn();
    (window as any).SHOGUN_RUNTIME = { pushToast };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);

    render(<AiFieldsPanel />);

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'ai_field.list',
        { limit: 12, query: '', ownerEntityId: '' },
        { silentError: true },
      );
    });

    fireEvent.change(screen.getByPlaceholderText('company:acme / deal:seed-round'), {
      target: { value: 'company:aurora' },
    });
    fireEvent.change(screen.getByPlaceholderText('next_action'), {
      target: { value: 'blocker' },
    });
    fireEvent.change(screen.getByPlaceholderText('Track the most important next action for this entity using recent evidence.'), {
      target: { value: 'Track the security blocker.' },
    });
    fireEvent.change(screen.getByPlaceholderText('Send security follow-up with timeline and owner.'), {
      target: { value: 'Security questionnaire pending' },
    });
    fireEvent.change(screen.getByPlaceholderText('m_123, m_456'), {
      target: { value: 'mem-1' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save AI Field' }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'ai_field.upsert',
        {
          ownerEntityId: 'company:aurora',
          fieldName: 'blocker',
          instruction: 'Track the security blocker.',
          currentValue: 'Security questionnaire pending',
          confidence: 0.72,
          evidenceEventIds: ['mem-1'],
        },
        { silentError: true },
      );
    });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect((refreshSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ reason: 'ai-field-created' });
    expect(pushToast).toHaveBeenCalledWith('AI Field を保存しました', 'success');

    window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
  });

  it('reloads the AI fields list when the shared action layer refreshes', async () => {
    let listCount = 0;
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        listCount += 1;
        return Promise.resolve({
          ok: true,
          data: {
            items: listCount === 1
              ? []
              : [
                  {
                    id: 'field-refresh-1',
                    ownerEntityId: 'company:aurora',
                    fieldName: 'blocker',
                    instruction: 'Track the security blocker.',
                    currentValue: 'Procurement review pending',
                    confidence: 0.84,
                    evidenceEventIds: [],
                  },
                ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<AiFieldsPanel />);

    await waitFor(() => {
      expect(screen.getByText('No AI Fields yet. Add one from the form to start tracking shared context such as blockers, next actions, or investor concerns.')).toBeInTheDocument();
    });

    window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail: { reason: 'test-refresh' } }));

    await waitFor(() => {
      expect(screen.getByText('Procurement review pending')).toBeInTheDocument();
    });
  });
});
