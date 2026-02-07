import { PANTRY_STORAGE_KEY } from '@/lib/constants';
import { canonicalizeIngredient, expirationDateForItem, estimateExpirationDate } from '@/lib/shelfLife';
import type { InventoryItem } from '@/lib/types';

type LegacyIngredient = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  purchaseDate: string;
  expirationDate: string;
};

function isLegacyIngredient(item: unknown): item is LegacyIngredient {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.quantity === 'number' &&
    typeof candidate.expirationDate === 'string'
  );
}

function isInventoryItem(item: unknown): item is InventoryItem {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.canonicalName === 'string' &&
    typeof candidate.displayName === 'string' &&
    typeof candidate.quantity === 'number' &&
    typeof candidate.computedExpirationDate === 'string'
  );
}

function migrateLegacy(item: LegacyIngredient): InventoryItem {
  const now = new Date().toISOString();
  const { canonicalName } = canonicalizeIngredient(item.name);

  return {
    id: item.id,
    canonicalName,
    displayName: item.name,
    quantity: item.quantity,
    unit: item.unit,
    purchaseDate: item.purchaseDate || now,
    computedExpirationDate: item.expirationDate || estimateExpirationDate(item.name, item.purchaseDate),
    source: 'manual',
    createdAt: now,
    updatedAt: now,
  };
}

export function loadPantryFromStorage(): InventoryItem[] {
  if (typeof window === 'undefined') return [];

  const raw = window.localStorage.getItem(PANTRY_STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown[];
    const converted: InventoryItem[] = [];

    for (const item of parsed) {
      if (isInventoryItem(item)) {
        converted.push(item);
      } else if (isLegacyIngredient(item)) {
        converted.push(migrateLegacy(item));
      }
    }

    return converted;
  } catch {
    window.localStorage.removeItem(PANTRY_STORAGE_KEY);
    return [];
  }
}

export function savePantryToStorage(
  items: InventoryItem[],
  options?: { emitEvent?: boolean },
): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(items));
  if (options?.emitEvent ?? true) {
    window.dispatchEvent(new Event('pantry:updated'));
  }
}

export function createInventoryItem(input: {
  name: string;
  quantity: number;
  unit: string;
  purchaseDate?: string;
  expirationDateOverride?: string;
  source: 'manual' | 'receipt';
}): InventoryItem {
  const now = new Date().toISOString();
  const purchaseDate = input.purchaseDate ?? now;
  const { canonicalName } = canonicalizeIngredient(input.name);
  const computedExpirationDate = expirationDateForItem({
    canonicalName,
    purchaseDate,
  });

  return {
    id: crypto.randomUUID(),
    canonicalName,
    displayName: input.name.trim() || canonicalName,
    quantity: input.quantity,
    unit: input.unit || 'item',
    purchaseDate,
    computedExpirationDate,
    overrideExpirationDate: input.expirationDateOverride
      ? new Date(input.expirationDateOverride).toISOString()
      : undefined,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
}
