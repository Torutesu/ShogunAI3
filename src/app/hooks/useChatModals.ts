import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface UseChatModalsResult {
  chatMenu: any;
  chatRenameModal: any;
  chatDeleteModal: any;
  chatWorkModal: any;
  setChatMenu: Dispatch<SetStateAction<any>>;
  setChatRenameModal: Dispatch<SetStateAction<any>>;
  setChatDeleteModal: Dispatch<SetStateAction<any>>;
  setChatWorkModal: Dispatch<SetStateAction<any>>;
}

export function useChatModals(): UseChatModalsResult {
  const [chatMenu, setChatMenu] = useState<any>({ open: false, chatId: null, x: 0, y: 0, width: 240 });
  const [chatRenameModal, setChatRenameModal] = useState<any>({ open: false, chatId: null, value: '' });
  const [chatDeleteModal, setChatDeleteModal] = useState<any>({ open: false, chatId: null });
  const [chatWorkModal, setChatWorkModal] = useState<any>({ open: false, chatId: null, query: '' });
  return {
    chatMenu,
    chatRenameModal,
    chatDeleteModal,
    chatWorkModal,
    setChatMenu,
    setChatRenameModal,
    setChatDeleteModal,
    setChatWorkModal,
  };
}
