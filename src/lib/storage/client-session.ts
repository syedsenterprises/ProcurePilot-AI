import { ProcurementMessage } from '@/types/procurement';

export const STORAGE_VERSION = 1;
export const CART_STORAGE_KEY = 'procurepilot_cart_session_v1';
export const CHAT_STORAGE_KEY = 'procurepilot_chat_session_v1';
export const MAX_STORED_MESSAGES = 40;
export const MAX_STORAGE_BYTES = 512 * 1024; // 512 KB safeguard

export interface PersistedCartData {
  version: number;
  updatedAt: number;
  budget: number | null;
  items: Array<{ productId: string; quantity: number }>;
  compareIds: string[];
}

export interface PersistedChatData {
  version: number;
  updatedAt: number;
  messages: ProcurementMessage[];
}

/**
 * Safe feature detection for localStorage availability
 * Handles SSR, sandboxed iframes, private browsing mode, and security exceptions
 */
export function isStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const testKey = '__procurepilot_storage_probe__';
    window.localStorage.setItem(testKey, testKey);
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads and strictly validates saved cart & budget session
 */
export function loadCartSession(): {
  budget: number | null;
  items: Array<{ productId: string; quantity: number }>;
  compareIds: string[];
} | null {
  if (!isStorageAvailable()) return null;

  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PersistedCartData>;
    if (!parsed || typeof parsed !== 'object') return null;

    // Check version
    if (parsed.version !== STORAGE_VERSION) {
      window.localStorage.removeItem(CART_STORAGE_KEY);
      return null;
    }

    // Validate budget
    let budget: number | null = null;
    if (typeof parsed.budget === 'number' && !isNaN(parsed.budget) && parsed.budget >= 0) {
      budget = parsed.budget;
    } else if (parsed.budget === null) {
      budget = null;
    }

    // Validate cart items
    const items: Array<{ productId: string; quantity: number }> = [];
    if (Array.isArray(parsed.items)) {
      for (const item of parsed.items) {
        if (
          item &&
          typeof item === 'object' &&
          typeof item.productId === 'string' &&
          item.productId.trim().length > 0 &&
          typeof item.quantity === 'number' &&
          item.quantity > 0
        ) {
          items.push({
            productId: item.productId.trim(),
            quantity: Math.min(100, Math.max(1, Math.floor(item.quantity)))
          });
        }
      }
    }

    // Validate compare IDs
    const compareIds: string[] = [];
    if (Array.isArray(parsed.compareIds)) {
      for (const id of parsed.compareIds) {
        if (typeof id === 'string' && id.trim().length > 0 && compareIds.length < 4) {
          compareIds.push(id.trim());
        }
      }
    }

    return { budget, items, compareIds };
  } catch (err) {
    console.warn('Failed to parse cart session from storage:', err);
    try {
      window.localStorage.removeItem(CART_STORAGE_KEY);
    } catch {
      // Ignore
    }
    return null;
  }
}

/**
 * Saves cart & budget session safely with quota protections
 */
export function saveCartSession(data: {
  budget: number | null;
  items: Array<{ productId: string; quantity: number }>;
  compareIds: string[];
}): void {
  if (!isStorageAvailable()) return;

  try {
    const payload: PersistedCartData = {
      version: STORAGE_VERSION,
      updatedAt: Date.now(),
      budget: typeof data.budget === 'number' && !isNaN(data.budget) ? data.budget : null,
      items: data.items.map((i) => ({
        productId: i.productId,
        quantity: Math.min(100, Math.max(1, Math.floor(i.quantity)))
      })),
      compareIds: data.compareIds.slice(0, 4)
    };

    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_STORAGE_BYTES) {
      console.warn('Cart session payload exceeds maximum safe storage bytes; skipping save');
      return;
    }

    window.localStorage.setItem(CART_STORAGE_KEY, serialized);
  } catch (err) {
    console.warn('Failed to save cart session to storage:', err);
  }
}

/**
 * Clears cart items while optionally preserving the current budget
 */
export function clearCartSession(preserveBudget = true): void {
  if (!isStorageAvailable()) return;

  try {
    if (preserveBudget) {
      const existing = loadCartSession();
      saveCartSession({
        budget: existing ? existing.budget : null,
        items: [],
        compareIds: existing ? existing.compareIds : []
      });
    } else {
      window.localStorage.removeItem(CART_STORAGE_KEY);
    }
  } catch {
    // Ignore
  }
}

/**
 * Loads and validates chat conversation history
 */
export function loadChatSession(): { messages: ProcurementMessage[] } | null {
  if (!isStorageAvailable()) return null;

  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PersistedChatData>;
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.version !== STORAGE_VERSION) {
      window.localStorage.removeItem(CHAT_STORAGE_KEY);
      return null;
    }

    if (!Array.isArray(parsed.messages)) return null;

    const validMessages: ProcurementMessage[] = [];
    for (const msg of parsed.messages) {
      if (
        msg &&
        typeof msg === 'object' &&
        typeof msg.id === 'string' &&
        (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') &&
        typeof msg.content === 'string'
      ) {
        validMessages.push(msg as ProcurementMessage);
      }
    }

    if (validMessages.length === 0) return null;

    return {
      messages: validMessages.slice(-MAX_STORED_MESSAGES)
    };
  } catch (err) {
    console.warn('Failed to parse chat session from storage:', err);
    try {
      window.localStorage.removeItem(CHAT_STORAGE_KEY);
    } catch {
      // Ignore
    }
    return null;
  }
}

/**
 * Saves chat conversation history with size and message length enforcement
 */
export function saveChatSession(data: { messages: ProcurementMessage[] }): void {
  if (!isStorageAvailable()) return;

  try {
    const trimmed = data.messages.slice(-MAX_STORED_MESSAGES);
    const payload: PersistedChatData = {
      version: STORAGE_VERSION,
      updatedAt: Date.now(),
      messages: trimmed
    };

    let serialized = JSON.stringify(payload);
    if (serialized.length > MAX_STORAGE_BYTES) {
      // Fallback: trim to newest 15 messages if still too large
      payload.messages = trimmed.slice(-15);
      serialized = JSON.stringify(payload);
    }

    if (serialized.length <= MAX_STORAGE_BYTES) {
      window.localStorage.setItem(CHAT_STORAGE_KEY, serialized);
    }
  } catch (err) {
    console.warn('Failed to save chat session to storage:', err);
  }
}

/**
 * Clears chat conversation history
 */
export function clearChatSession(): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

/**
 * Resets all client-persisted procurement session data
 */
export function resetAllClientSessions(): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.removeItem(CART_STORAGE_KEY);
    window.localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    // Ignore
  }
}
