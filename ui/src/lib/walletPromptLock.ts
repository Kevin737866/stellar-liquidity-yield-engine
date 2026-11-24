export type WalletPromptKind = 'connect' | 'sign';

export const WALLET_PROMPT_BUSY_MESSAGE =
  'A wallet prompt is already open. Approve or reject it before starting another transaction.';

export const TRANSACTION_ALREADY_IN_FLIGHT_MESSAGE =
  'A transaction is already in progress. Wait for it to finish before starting another.';

export class WalletPromptBusyError extends Error {
  readonly requestedKind: WalletPromptKind;

  constructor(requestedKind: WalletPromptKind) {
    super(WALLET_PROMPT_BUSY_MESSAGE);
    this.name = 'WalletPromptBusyError';
    this.requestedKind = requestedKind;
  }
}

type WalletPromptListener = (activePrompts: WalletPromptKind[]) => void;

let activePrompt: WalletPromptKind | null = null;
const listeners = new Set<WalletPromptListener>();

export const getActiveWalletPrompts = (): WalletPromptKind[] =>
  activePrompt ? [activePrompt] : [];

export const isWalletPromptActive = (kind?: WalletPromptKind): boolean =>
  kind ? activePrompt === kind : activePrompt !== null;

const notifyListeners = (): void => {
  const snapshot = getActiveWalletPrompts();
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {}
  });
};

export const subscribeToWalletPrompt = (
  listener: WalletPromptListener
): (() => void) => {
  listeners.add(listener);
  listener(getActiveWalletPrompts());
  return () => {
    listeners.delete(listener);
  };
};

export const runWithWalletPrompt = async <T>(
  kind: WalletPromptKind,
  task: () => Promise<T>
): Promise<T> => {
  if (activePrompt) {
    throw new WalletPromptBusyError(kind);
  }

  activePrompt = kind;
  notifyListeners();

  try {
    return await task();
  } finally {
    activePrompt = null;
    notifyListeners();
  }
};
