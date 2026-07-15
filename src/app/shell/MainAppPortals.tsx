import React, { lazy, Suspense } from 'react';
import { ConfirmWriteModal } from '@/shared/modals';
import { profileStateFromSections, applySavedAppearance } from '@/app/lib/helpers';
import { historicalImportResultNavigation } from '@/app/lib/native-navigation';
import { ShareModal } from './ShareModal';
import { TweaksPanel } from './TweaksPanel';
import { FallbackWriteModal } from './FallbackWriteModal';
import { ChatDeleteModal } from './portals/ChatDeleteModal';
import { ChatRenameModal } from './portals/ChatRenameModal';
import { ChatMenu } from './portals/ChatMenu';
import { ChatWorkModal } from './portals/ChatWorkModal';
import { ContextPanel } from './portals/ContextPanel';
import { HistoricalImportModal } from './portals/HistoricalImportModal';
import { UserFloatMenu } from './portals/UserFloatMenu';
import { PasteTokenModal } from './portals/PasteTokenModal';
import { HummingbirdOverlay } from './portals/HummingbirdOverlay';
import { useShogunRuntime, type ToastKind } from '@/app/context/ShogunRuntimeContext';

const SettingsModal = lazy(() => import('@/features/settings').then((m) => ({ default: m.SettingsModal })));

declare const window: Window;

export interface MainAppPortalsProps {
  shareOpen: boolean;
  setShareOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  shareMode: any;
  setShareMode: (v: any) => void;
  chats: any[];
  activeChat: any;
  hummingbirdOpen: boolean;
  language: string;
  hummingbirdInput: string;
  setHummingbirdOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setHummingbirdInput: (v: string | ((prev: string) => string)) => void;
  userOpen: boolean;
  userAnchor: any;
  profileDisplayName: string;
  profileAvatarGlyph: string;
  profileAvatarImageDataUrl: string;
  setUserOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setSettingsOpen: (v: any) => void;
  contextPanelOpen: boolean;
  contextPanelAnchor: any;
  setContextPanelOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  chatMenu: any;
  chatMenuTarget: any;
  chatMenuTargetWork: any;
  closeChatMenu: () => void;
  runChatMenuAction: (action: any, id: any) => void;
  chatDeleteModal: any;
  chatDeleteTarget: any;
  setChatDeleteModal: (v: any) => void;
  confirmDeleteChat: () => void;
  chatRenameModal: any;
  setChatRenameModal: (v: any) => void;
  submitRenameModal: () => void;
  chatWorkModal: any;
  filteredWorkProjects: any[];
  setChatWorkModal: (v: any) => void;
  assignChatToWork: (workId: any, workName: any) => void;
  createAndAssignWork: () => void;
  settingsOpen: any;
  setProfileDisplayName: (v: string | ((prev: string) => string)) => void;
  setProfileAvatarGlyph: (v: string | ((prev: string) => string)) => void;
  setProfileAvatarImageDataUrl: (v: string | ((prev: string) => string)) => void;
  writeConfirm: any;
  writePending: boolean;
  setWriteConfirm: (v: any) => void;
  setWritePending: (v: boolean | ((prev: boolean) => boolean)) => void;
  requestWriteAction: (actionKey: any, payload: any, title: any, description: any) => void;
  historicalImport: any;
  historicalImportBusy: boolean;
  historicalImportProgress: any;
  setHistoricalImport: (v: any) => void;
  setHistoricalImportBusy: (v: boolean | ((prev: boolean) => boolean)) => void;
  setHistoricalImportProgress: (v: any) => void;
  pasteTokenModal: any;
  setPasteTokenModal: (v: any) => void;
  toast: any;
  setToast: (v: any) => void;
  toastTimerRef: React.MutableRefObject<any>;
  editMode: boolean;
  tweaks: any;
  onTweakUpdate: (key: string, value: any) => void;
}

export function MainAppPortals(props: MainAppPortalsProps): React.ReactElement {
  const { executeAction, pushToast } = useShogunRuntime();
  const WriteModal = ConfirmWriteModal || FallbackWriteModal;

  return (
    <>
      <ShareModal
        shareOpen={props.shareOpen}
        setShareOpen={props.setShareOpen}
        shareMode={props.shareMode}
        setShareMode={props.setShareMode}
        chats={props.chats}
        activeChat={props.activeChat}
        executeAction={executeAction}
      />

      <HummingbirdOverlay
        open={props.hummingbirdOpen}
        language={props.language}
        input={props.hummingbirdInput}
        activeChat={props.activeChat}
        onClose={() => props.setHummingbirdOpen(false)}
        onInputChange={props.setHummingbirdInput}
        pushToast={(message, kind) => pushToast(message, kind as ToastKind)}
        executeAction={executeAction}
      />

      <UserFloatMenu
        open={props.userOpen}
        anchor={props.userAnchor}
        profileDisplayName={props.profileDisplayName}
        profileAvatarGlyph={props.profileAvatarGlyph}
        profileAvatarImageDataUrl={props.profileAvatarImageDataUrl}
        onClose={() => props.setUserOpen(false)}
        onOpenSettings={(pane) => props.setSettingsOpen(pane)}
      />

      <ContextPanel
        open={props.contextPanelOpen}
        anchor={props.contextPanelAnchor}
        onClose={() => props.setContextPanelOpen(false)}
        onOpenSettings={(pane) => props.setSettingsOpen(pane)}
      />

      <ChatMenu
        open={props.chatMenu.open}
        chatId={props.chatMenu.chatId}
        x={props.chatMenu.x}
        y={props.chatMenu.y}
        width={props.chatMenu.width}
        chatMenuTarget={props.chatMenuTarget}
        chatMenuTargetWork={props.chatMenuTargetWork}
        onClose={props.closeChatMenu}
        onAction={props.runChatMenuAction}
      />

      <ChatDeleteModal
        open={props.chatDeleteModal.open}
        chatDeleteTarget={props.chatDeleteTarget}
        onClose={() => props.setChatDeleteModal({ open: false, chatId: null })}
        onConfirm={props.confirmDeleteChat}
      />

      <ChatRenameModal
        open={props.chatRenameModal.open}
        value={props.chatRenameModal.value}
        onClose={() => props.setChatRenameModal({ open: false, chatId: null, value: '' })}
        onChange={(value) => props.setChatRenameModal((s: any) => ({ ...s, value }))}
        onSubmit={props.submitRenameModal}
      />

      <ChatWorkModal
        open={props.chatWorkModal.open}
        query={props.chatWorkModal.query}
        filteredWorkProjects={props.filteredWorkProjects}
        onClose={() => props.setChatWorkModal({ open: false, chatId: null, query: '' })}
        onQueryChange={(query) => props.setChatWorkModal((s: any) => ({ ...s, query }))}
        onAssignToWork={props.assignChatToWork}
        onCreateAndAssign={props.createAndAssignWork}
      />

      {props.settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            pane={props.settingsOpen}
            setPane={props.setSettingsOpen}
            close={() => {
              props.setSettingsOpen(null);
              (async () => {
                const r = await executeAction('settings.load', {}, { silentError: true });
                const settingsData = r.data as { settings?: { sections?: Record<string, unknown> } } | undefined;
                if (r.ok && settingsData?.settings?.sections) {
                  const sec = settingsData.settings.sections;
                  applySavedAppearance(sec);
                  const p = profileStateFromSections(sec);
                  props.setProfileDisplayName(p.name);
                  props.setProfileAvatarGlyph(p.avatarGlyph);
                  props.setProfileAvatarImageDataUrl(p.avatarImageDataUrl);
                }
              })();
            }}
          />
        </Suspense>
      )}

      <WriteModal
        open={props.writeConfirm.open}
        title={props.writeConfirm.title}
        description={props.writeConfirm.description}
        actionName={props.writeConfirm.actionKey}
        payload={props.writeConfirm.payload}
        pending={props.writePending}
        onCancel={() => props.setWriteConfirm({ open: false, actionKey: null, payload: null, title: null, description: null })}
        onConfirm={async () => {
          if (!props.writeConfirm.actionKey) return;
          const actionKey = props.writeConfirm.actionKey;
          const payload = props.writeConfirm.payload;
          props.setWritePending(true);
          const res = await executeAction(actionKey, payload, { successMessage: 'Action completed' });
          props.setWritePending(false);
          props.setWriteConfirm({ open: false, actionKey: null, payload: null, title: null, description: null });
          if (actionKey === 'memory.delete' && res && res.ok) {
            window.dispatchEvent(new CustomEvent('shogun-memory-index-changed'));
          }
        }}
      />

      <HistoricalImportModal
        historicalImport={props.historicalImport}
        historicalImportBusy={props.historicalImportBusy}
        historicalImportProgress={props.historicalImportProgress}
        onClose={() => props.setHistoricalImport(null)}
        onDaysChange={(days) => props.setHistoricalImport((prev: any) => (prev ? { ...prev, days } : prev))}
        onSkip={async () => {
          const provider = props.historicalImport!.provider;
          props.setHistoricalImportBusy(true);
          await executeAction(
            'settings.save',
            { section: provider, historicalSyncDays: 0 },
            { silentError: true },
          );
          props.setHistoricalImportBusy(false);
          props.setHistoricalImport(null);
        }}
        onImport={async () => {
          const { provider, days } = props.historicalImport!;
          const providerLabels: Record<string, string> = {
            gmail: 'Gmail',
            google_calendar: 'Calendar',
            google_drive: 'Drive',
            slack: 'Slack',
            notion: 'Notion',
            github: 'GitHub',
            linear: 'Linear',
            zoom: 'Zoom',
          };
          const actionKeys: Record<string, string> = {
            gmail: 'gmail.sync',
            google_calendar: 'calendar.sync',
            google_drive: 'drive.sync',
            slack: 'slack.sync',
            notion: 'notion.sync',
            github: 'github.sync',
            linear: 'linear.sync',
            zoom: 'zoom.sync',
          };
          const label = providerLabels[provider] || provider;
          const actionKey = actionKeys[provider] || `${provider}.sync`;
          props.setHistoricalImportBusy(true);
          pushToast(`${label}: importing past ${days} days…`, 'info');
          const syncPayload = provider === 'google_calendar'
            ? { calendarId: 'primary', days }
            : { days };
          const res = await executeAction(actionKey, syncPayload, { silentError: true });
          const importSucceeded = !!(res && res.ok);
          if (res && res.ok) {
            const syncData = res.data as { ingested?: number; skipped?: number } | undefined;
            const n = syncData?.ingested || 0;
            const skipped = syncData?.skipped || 0;
            const msgSuffix = skipped > 0 ? ` (${skipped} already in memory)` : '';
            pushToast(`${label}: imported ${n} item(s)${msgSuffix}`, 'success');
          } else {
            const msg = (res && res.error && res.error.message) || 'Import failed';
            pushToast(msg, 'error');
          }
          await executeAction(
            'settings.save',
            { section: provider, historicalSyncDays: days },
            { silentError: true },
          );
          if (!importSucceeded) {
            props.setHistoricalImportBusy(false);
            props.setHistoricalImport(null);
            props.setHistoricalImportProgress(null);
            window.dispatchEvent(new CustomEvent('shogun-memory-index-changed'));
            window.dispatchEvent(
              new CustomEvent('shogun-app-navigate', {
                detail: historicalImportResultNavigation(false),
              }),
            );
          }
        }}
      />

      <PasteTokenModal
        pasteTokenModal={props.pasteTokenModal}
        onClose={() => props.setPasteTokenModal(null)}
        onTokenChange={(token) => props.setPasteTokenModal((prev: any) => (prev ? { ...prev, token } : prev))}
        onSave={async () => {
          const provider = props.pasteTokenModal!.provider;
          const token = props.pasteTokenModal!.token.trim();
          if (!token) return;
          props.setPasteTokenModal((prev: any) => (prev ? { ...prev, busy: true } : prev));
          const res = await executeAction(
            'integrations.import_credentials',
            { provider, accessToken: token },
            { silentError: true },
          );
          if (res && res.ok) {
            pushToast(`${provider}: token saved`, 'success');
            props.setPasteTokenModal(null);
          } else {
            const msg = (res && res.error && res.error.message) || 'Save failed';
            pushToast(msg, 'error');
            props.setPasteTokenModal((prev: any) => (prev ? { ...prev, busy: false } : prev));
          }
        }}
      />

      {props.toast && (
        <div className={'app-toast ' + props.toast.kind + (props.toast.action ? ' has-action' : '')}>
          <span className="app-toast__msg">{props.toast.message}</span>
          {props.toast.action && (
            <button
              type="button"
              className="app-toast__action"
              onClick={() => {
                try { props.toast.action.onClick(); } catch { /* ignore */ }
                if (props.toastTimerRef.current) window.clearTimeout(props.toastTimerRef.current);
                props.setToast(null);
              }}
            >
              {props.toast.action.label}
            </button>
          )}
        </div>
      )}

      <TweaksPanel editMode={props.editMode} tweaks={props.tweaks} onUpdate={props.onTweakUpdate} />
    </>
  );
}
