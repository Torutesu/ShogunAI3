import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { INITIAL_CHAT_HISTORY } from '../lib/constants';

export interface UseChatHistoryResult {
  activeChat: any;
  chats: any[];
  dragId: any;
  dragOver: any;
  chatGroupsOpen: any;
  setActiveChat: Dispatch<SetStateAction<any>>;
  setChats: Dispatch<SetStateAction<any[]>>;
  setDragId: Dispatch<SetStateAction<any>>;
  setDragOver: Dispatch<SetStateAction<any>>;
  setChatGroupsOpen: Dispatch<SetStateAction<any>>;
}

export function useChatHistory(): UseChatHistoryResult {
  const [activeChat, setActiveChat] = useState<any>(() => null);
  const [chats, setChats] = useState<any[]>(INITIAL_CHAT_HISTORY);
  const [dragId, setDragId] = useState<any>(null);
  const [dragOver, setDragOver] = useState<any>(null); // {id, pos:'before'|'after'|'fav'|'chats'}
  const [chatGroupsOpen, setChatGroupsOpen] = useState<any>({ favorite: true, chats: true });
  return {
    activeChat,
    chats,
    dragId,
    dragOver,
    chatGroupsOpen,
    setActiveChat,
    setChats,
    setDragId,
    setDragOver,
    setChatGroupsOpen,
  };
}
