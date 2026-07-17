import { useCallback, useEffect } from 'react';
import { t } from '@/shared/lib/i18n';
import type { Dispatch, SetStateAction } from 'react';

declare const window: any;

export interface UseChatActionsResult {
  toggleFav: (id: any) => void;
  openChatMenuAt: (chatId: any, x: any, y: any) => void;
  closeChatMenu: () => void;
  openRenameModal: (id: any) => void;
  submitRenameModal: () => void;
  openDeleteModal: (id: any) => void;
  confirmDeleteChat: () => void;
  openWorkModal: (id: any) => void;
  assignChatToWork: (workId: any, workName: any) => void;
  createAndAssignWork: () => void;
  toggleWorkArchiveForChat: (id: any) => void;
  runChatMenuAction: (action: any, id: any) => void;
}

export function useChatActions(
  chats: any[],
  setChats: Dispatch<SetStateAction<any[]>>,
  activeChat: any,
  setActiveChat: Dispatch<SetStateAction<any>>,
  setActive: Dispatch<SetStateAction<string>>,
  _workProjects: any[],
  setWorkProjects: Dispatch<SetStateAction<any[]>>,
  chatMenu: any,
  setChatMenu: Dispatch<SetStateAction<any>>,
  chatRenameModal: any,
  setChatRenameModal: Dispatch<SetStateAction<any>>,
  chatDeleteModal: any,
  setChatDeleteModal: Dispatch<SetStateAction<any>>,
  chatWorkModal: any,
  setChatWorkModal: Dispatch<SetStateAction<any>>,
  pushToast: (message: any, kind?: any) => void,
): UseChatActionsResult {
  const toggleFav = useCallback(
    (id: any) => setChats((cs) => cs.map((c) => (c.id === id ? { ...c, favorite: !c.favorite } : c))),
    [setChats],
  );

  const openChatMenuAt = useCallback(
    (chatId: any, x: any, y: any) => {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      let menuW = 248;
      const menuH = 220;
      const edgePad = 8;
      let minX = edgePad;
      let maxX = vw - menuW - edgePad;
      let minY = edgePad;
      let maxY = vh - menuH - edgePad;
      const sidebarEl = document.querySelector('.sidebar');
      if (sidebarEl && typeof sidebarEl.getBoundingClientRect === 'function') {
        const r = sidebarEl.getBoundingClientRect();
        const availableW = Math.max(180, Math.floor(r.width) - edgePad * 2);
        menuW = Math.min(menuW, availableW);
        minX = Math.max(edgePad, Math.floor(r.left) + edgePad);
        maxX = Math.min(vw - menuW - edgePad, Math.floor(r.right) - menuW - edgePad);
        minY = Math.max(edgePad, Math.floor(r.top) + edgePad);
        maxY = Math.min(vh - menuH - edgePad, Math.floor(r.bottom) - menuH - edgePad);
      }
      if (maxX < minX) maxX = minX;
      if (maxY < minY) maxY = minY;
      const clampedX = Math.max(minX, Math.min(x, maxX));
      const clampedY = Math.max(minY, Math.min(y, maxY));
      setChatMenu({ open: true, chatId, x: clampedX, y: clampedY, width: menuW });
    },
    [setChatMenu],
  );

  const closeChatMenu = useCallback(
    () => setChatMenu({ open: false, chatId: null, x: 0, y: 0, width: 240 }),
    [setChatMenu],
  );

  const openRenameModal = useCallback(
    (id: any) => {
      const current = chats.find((c) => c.id === id);
      if (!current) return;
      setChatRenameModal({ open: true, chatId: id, value: current.title || '' });
    },
    [chats, setChatRenameModal],
  );

  const submitRenameModal = useCallback(() => {
    const id = chatRenameModal.chatId;
    const trimmed = String(chatRenameModal.value || '').trim();
    if (!id || !trimmed) return;
    setChats((cs) => cs.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
    setChatRenameModal({ open: false, chatId: null, value: '' });
    pushToast(t('Chat renamed', 'チャット名を更新しました'), 'success');
  }, [chatRenameModal, setChatRenameModal, setChats, pushToast]);

  const openDeleteModal = useCallback(
    (id: any) => {
      const target = chats.find((c) => c.id === id);
      if (!target) return;
      setChatDeleteModal({ open: true, chatId: id });
    },
    [chats, setChatDeleteModal],
  );

  const confirmDeleteChat = useCallback(() => {
    const id = chatDeleteModal.chatId;
    if (!id) return;
    setChats((cs) => {
      const next = cs.filter((c) => c.id !== id);
      if (activeChat === id) {
        setActiveChat(next[0] ? next[0].id : null);
      }
      return next;
    });
    setChatDeleteModal({ open: false, chatId: null });
    pushToast(t('Chat deleted', 'チャットを削除しました'), 'success');
  }, [activeChat, chatDeleteModal.chatId, setActiveChat, setChatDeleteModal, setChats, pushToast]);

  const openWorkModal = useCallback(
    (id: any) => {
      const target = chats.find((c) => c.id === id);
      if (!target) return;
      setChatWorkModal({ open: true, chatId: id, query: '' });
    },
    [chats, setChatWorkModal],
  );

  const assignChatToWork = useCallback(
    (workId: any, workName: any) => {
      let id = chatWorkModal.chatId;
      const newChat = !id;
      if (newChat) {
        id = `c${Date.now()}`;
        const item = { id, title: 'New Chat', time: '', when: 'TODAY', jp: '今日', favorite: false, workProjectId: workId, workProjectName: workName };
        setChats((prev) => [item, ...prev]);
        setActiveChat(id);
      } else {
        setChats((cs) => cs.map((c) => (c.id === id ? { ...c, workProjectId: workId, workProjectName: workName } : c)));
      }
      setChatWorkModal({ open: false, chatId: null, query: '' });
      setActive(newChat ? 'chat' : 'work');
      pushToast(t(`Added to Work: ${workName}`, `Workに追加: ${workName}`), 'success');
    },
    [chatWorkModal.chatId, setActiveChat, setChatWorkModal, setChats, setActive, pushToast],
  );

  const createAndAssignWork = useCallback(() => {
    const name = String(chatWorkModal.query || '').trim();
    if (!name) return;
    const id = `w-${Date.now()}`;
    setWorkProjects((prev) => [...prev, { id, name }]);
    assignChatToWork(id, name);
  }, [assignChatToWork, chatWorkModal.query, setWorkProjects]);

  const toggleWorkArchiveForChat = useCallback(
    (id: any) => {
      const target = chats.find((c) => c.id === id);
      if (!target || !target.workProjectId) return;
      let nextArchived = false;
      setWorkProjects((prev) =>
        prev.map((p) => {
          if (p.id !== target.workProjectId) return p;
          nextArchived = p.archived !== true;
          return { ...p, archived: nextArchived };
        }),
      );
      pushToast(nextArchived ? t('Work archived', 'Workをアーカイブしました') : t('Work restored', 'Workを復元しました'), 'success');
    },
    [chats, setWorkProjects, pushToast],
  );

  const runChatMenuAction = useCallback(
    (action: any, id: any) => {
      if (!id) return;
      if (action === 'pin') {
        toggleFav(id);
        pushToast(t('Favorites updated', 'Favoriteを更新しました'), 'success');
      } else if (action === 'rename') {
        openRenameModal(id);
      } else if (action === 'work') {
        openWorkModal(id);
      } else if (action === 'workArchive') {
        toggleWorkArchiveForChat(id);
      } else if (action === 'delete') {
        openDeleteModal(id);
      }
      closeChatMenu();
    },
    [closeChatMenu, openDeleteModal, openRenameModal, openWorkModal, toggleFav, toggleWorkArchiveForChat, pushToast],
  );

  // Close chat menu on Escape
  useEffect(() => {
    if (!chatMenu.open) return undefined;
    const onKey = (e: any) => {
      if (e.key === 'Escape') closeChatMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatMenu.open, closeChatMenu]);

  return {
    toggleFav,
    openChatMenuAt,
    closeChatMenu,
    openRenameModal,
    submitRenameModal,
    openDeleteModal,
    confirmDeleteChat,
    openWorkModal,
    assignChatToWork,
    createAndAssignWork,
    toggleWorkArchiveForChat,
    runChatMenuAction,
  };
}

