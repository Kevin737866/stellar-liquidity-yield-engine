import { useCallback, useEffect, useState } from 'react';
import {
  getActiveWalletPrompts,
  subscribeToWalletPrompt,
  type WalletPromptKind,
} from '../lib/walletPromptLock';

export interface UseWalletPromptReturn {
  isWalletPromptActive: boolean;
  activeWalletPrompt: WalletPromptKind | null;
  isPromptKindActive: (kind: WalletPromptKind) => boolean;
}

export function useWalletPrompt(): UseWalletPromptReturn {
  const [activePrompts, setActivePrompts] = useState<WalletPromptKind[]>(() =>
    getActiveWalletPrompts()
  );

  useEffect(() => subscribeToWalletPrompt(setActivePrompts), []);

  const isPromptKindActive = useCallback(
    (kind: WalletPromptKind) => activePrompts.includes(kind),
    [activePrompts]
  );

  return {
    isWalletPromptActive: activePrompts.length > 0,
    activeWalletPrompt: activePrompts[0] ?? null,
    isPromptKindActive,
  };
}
