import React, { useRef, useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

const CHAT_DRAG_THRESHOLD_PX = 6;

export interface UseChatDragResult {
  dragIdRef: React.MutableRefObject<any>;
  dragOverRef: React.MutableRefObject<any>;
  suppressChatRowClickRef: React.MutableRefObject<boolean>;
  clearChatDrag: () => void;
  applyChatDragReorder: () => void;
  updateDragOverFromPoint: (clientX: any, clientY: any) => void;
  onChatRowPointerDown: (id: any) => (e: any) => void;
}

export function useChatDrag(
  setChats: Dispatch<SetStateAction<any[]>>,
  setDragId: Dispatch<SetStateAction<any>>,
  setDragOver: Dispatch<SetStateAction<any>>,
): UseChatDragResult {
  const dragIdRef = useRef<any>(null);
  const dragOverRef = useRef<any>(null);
  const suppressChatRowClickRef = useRef(false);

  const clearChatDrag = useCallback(() => {
    dragIdRef.current = null;
    dragOverRef.current = null;
    setDragId(null);
    setDragOver(null);
  }, [setDragId, setDragOver]);

  /** HTML5 drag/drop is unreliable in Tauri/WKWebView; reorder uses pointer events instead. */
  const applyChatDragReorder = useCallback(() => {
    const did = dragIdRef.current;
    const over = dragOverRef.current;
    if (!did || !over) return;
    setChats((cs) => {
      const src = cs.find((c) => c.id === did);
      if (!src) return cs;
      const rest = cs.filter((c) => c.id !== did);
      if (over.id === null) {
        const moved = { ...src, favorite: over.pos === 'fav' };
        return [...rest, moved];
      }
      const target = rest.find((c) => c.id === over.id);
      if (!target) return cs;
      const moved = { ...src, favorite: target.favorite };
      const idx = rest.findIndex((c) => c.id === over.id);
      const insertAt = over.pos === 'before' ? idx : idx + 1;
      const out = [...rest];
      out.splice(insertAt, 0, moved);
      return out;
    });
  }, [setChats]);

  const updateDragOverFromPoint = useCallback((clientX: any, clientY: any) => {
    const did = dragIdRef.current;
    let root;
    try {
      root = document.elementFromPoint(clientX, clientY);
    } catch (_) {
      return;
    }
    if (!root) return;
    const row = (root as any).closest?.('[data-chat-row]');
    if (row) {
      const rid = row.getAttribute('data-chat-row');
      if (rid === did) {
        dragOverRef.current = null;
        setDragOver(null);
        return;
      }
      if (rid) {
        const rect = row.getBoundingClientRect();
        const pos = clientY - rect.top < rect.height / 2 ? 'before' : 'after';
        const next = { id: rid, pos };
        dragOverRef.current = next;
        setDragOver(next);
        return;
      }
    }
    const bucket = (root as any).closest?.('[data-chat-bucket]');
    if (bucket) {
      const b = bucket.getAttribute('data-chat-bucket');
      if (b === 'fav' || b === 'chats') {
        const next = { id: null, pos: b };
        dragOverRef.current = next;
        setDragOver(next);
      }
    }
  }, [setDragOver]);

  const onChatRowPointerDown = useCallback(
    (id: any) => (e: any) => {
      if (e.button !== 0) return;
      if (e.target.closest?.('button')) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let armed = false;
      const move = (ev: any) => {
        if (!armed) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < CHAT_DRAG_THRESHOLD_PX) return;
          armed = true;
          dragIdRef.current = id;
          setDragId(id);
          dragOverRef.current = null;
          setDragOver(null);
          document.body.classList.add('chat-reorder-active');
        }
        updateDragOverFromPoint(ev.clientX, ev.clientY);
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        document.body.classList.remove('chat-reorder-active');
        if (armed) {
          applyChatDragReorder();
          suppressChatRowClickRef.current = true;
        }
        clearChatDrag();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [applyChatDragReorder, clearChatDrag, setDragId, setDragOver, updateDragOverFromPoint],
  );

  return {
    dragIdRef,
    dragOverRef,
    suppressChatRowClickRef,
    clearChatDrag,
    applyChatDragReorder,
    updateDragOverFromPoint,
    onChatRowPointerDown,
  };
}
