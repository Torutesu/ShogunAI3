export interface ChatComposerSeedOptions {
  text: string;
  webSearch?: boolean;
  assembleMemory?: boolean;
  autoSend?: boolean;
  newChat?: boolean;
  memoryAssemblyQuery?: string;
  memoryAssemblyLimit?: number;
  memoryAssemblySemantic?: boolean;
}

export interface EntityChatSeedInput {
  entityId: string;
  entityLabel?: string | null;
  rollupTitle?: string | null;
  fieldLabel?: string | null;
  actionLabel?: string | null;
}

export interface FieldChatSeedInput {
  ownerEntityId: string;
  fieldName: string;
  currentValue?: string | null;
  instruction: string;
  evidenceIds?: string[];
}

export interface ActionChatSeedInput {
  ownerEntityId: string;
  title: string;
  actionType: string;
  status: string;
  riskLevel: string;
  detail?: string | null;
}

export interface DraftChatSeedInput {
  ownerEntityId: string;
  title: string;
  actionType: string;
  draftContent: string;
  detail?: string | null;
}

export interface MeetingChatSeedInput {
  meetingId: string;
  title?: string | null;
  startedAt?: number | string | null;
  speakerCount?: number | null;
  segmentCount?: number | null;
  transcriptSnippet?: string | null;
  noteSnippet?: string | null;
  question?: string | null;
}

function clampMemoryAssemblyLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 12;
  return Math.min(80, Math.max(1, Math.floor(n)));
}

export function buildEntityChatSeed(input: EntityChatSeedInput): ChatComposerSeedOptions {
  const entityId = String(input.entityId || '').trim();
  const label = String(input.entityLabel || entityId).trim() || entityId;
  const lines = [
    `${label} (${entityId}) の状況を shared context から整理してください。`,
    input.rollupTitle ? `Rollup: ${String(input.rollupTitle).trim()}` : '',
    input.fieldLabel ? `Field: ${String(input.fieldLabel).trim()}` : '',
    input.actionLabel ? `Action: ${String(input.actionLabel).trim()}` : '',
    '必要なら次の一手も提案してください。',
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    assembleMemory: true,
    memoryAssemblyQuery: entityId,
    memoryAssemblyLimit: 14,
    memoryAssemblySemantic: true,
  };
}

export function buildFieldChatSeed(input: FieldChatSeedInput): ChatComposerSeedOptions {
  const evidenceIds = Array.isArray(input.evidenceIds) ? input.evidenceIds.filter(Boolean) : [];
  const lines = [
    `${input.ownerEntityId} の field を shared context から整理してください。`,
    `Field: ${input.fieldName}`,
    `Current value: ${input.currentValue || '(empty)'}`,
    `Instruction: ${input.instruction}`,
    evidenceIds.length ? `Evidence: ${evidenceIds.join(', ')}` : '',
    '必要なら解釈と次の一手を提案してください。',
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    assembleMemory: true,
    memoryAssemblyQuery: input.ownerEntityId,
    memoryAssemblyLimit: 14,
    memoryAssemblySemantic: true,
  };
}

export function buildActionChatSeed(input: ActionChatSeedInput): ChatComposerSeedOptions {
  const lines = [
    `${input.ownerEntityId} の action を shared context からレビューしてください。`,
    `Action: ${input.title}`,
    `Type: ${input.actionType}`,
    `Status: ${input.status}`,
    `Risk: ${input.riskLevel}`,
    input.detail ? `Detail: ${input.detail}` : '',
    '必要なら次の一手や修正案を提案してください。',
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    assembleMemory: true,
    memoryAssemblyQuery: input.ownerEntityId,
    memoryAssemblyLimit: 14,
    memoryAssemblySemantic: true,
  };
}

export function buildDraftChatSeed(input: DraftChatSeedInput): ChatComposerSeedOptions {
  const draftContent = String(input.draftContent || '').trim();
  const lines = [
    `${input.ownerEntityId} の draft を shared context と合わせてレビューしてください。`,
    `Action: ${input.title}`,
    `Type: ${input.actionType}`,
    input.detail ? `Detail: ${input.detail}` : '',
    draftContent ? `Draft:\n${draftContent}` : '',
    '必要なら改善版の文面、抜けている論点、次の一手を提案してください。',
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    assembleMemory: true,
    memoryAssemblyQuery: input.ownerEntityId,
    memoryAssemblyLimit: 14,
    memoryAssemblySemantic: true,
    newChat: true,
  };
}

export function buildMeetingChatSeed(input: MeetingChatSeedInput): ChatComposerSeedOptions {
  const meetingId = String(input.meetingId || '').trim();
  const title = String(input.title || '').trim() || 'Imported meeting';
  const startedAt = Number(input.startedAt);
  const startedLabel = Number.isFinite(startedAt) && startedAt > 0
    ? new Date(startedAt).toLocaleString('ja-JP')
    : '';
  const speakerCount = Number(input.speakerCount);
  const segmentCount = Number(input.segmentCount);
  const transcriptSnippet = String(input.transcriptSnippet || '').trim();
  const noteSnippet = String(input.noteSnippet || '').trim();
  const question = String(input.question || '').trim();
  const lines = [
    `${title} (${meetingId}) の会議内容を shared context から整理してください。`,
    question ? `Question: ${question}` : '',
    startedLabel ? `Started: ${startedLabel}` : '',
    Number.isFinite(speakerCount) && speakerCount > 0 ? `Speakers: ${speakerCount}` : '',
    Number.isFinite(segmentCount) && segmentCount > 0 ? `Segments: ${segmentCount}` : '',
    transcriptSnippet ? `Transcript snippet:\n${transcriptSnippet}` : '',
    noteSnippet ? `Note snippet:\n${noteSnippet}` : '',
    '決定事項、未解決事項、次の一手があれば整理してください。',
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    assembleMemory: true,
    memoryAssemblyQuery: `meeting:${meetingId}`,
    memoryAssemblyLimit: 14,
    memoryAssemblySemantic: true,
  };
}

export function openChatWithSeed(options: ChatComposerSeedOptions): void {
  const text = String(options.text || '').trim();
  const memoryAssemblyQuery = String(options.memoryAssemblyQuery || '').trim().slice(0, 480);
  if (options.newChat === true && typeof (window as any).SHOGUN_RUNTIME?.createNewChat === 'function') {
    (window as any).SHOGUN_RUNTIME.createNewChat();
  }
  const detail: Record<string, unknown> = {
    text,
    webSearch: options.webSearch === true,
    assembleMemory: options.assembleMemory !== false,
    autoSend: options.autoSend === true && text.length > 0,
  };

  if (options.assembleMemory !== false && memoryAssemblyQuery) {
    detail.memoryAssemblyPreset = {
      query: memoryAssemblyQuery,
      limit: clampMemoryAssemblyLimit(options.memoryAssemblyLimit),
      semantic: options.memoryAssemblySemantic !== false,
    };
  } else {
    detail.clearMemoryAssemblyPreset = true;
  }

  (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('chat');
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('shogun-chat-composer-seed', { detail }));
  }, 0);
}
