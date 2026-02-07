export type ItemSource = 'manual' | 'receipt';

export type InventoryItem = {
  id: string;
  canonicalName: string;
  displayName: string;
  quantity: number;
  unit: string;
  purchaseDate: string;
  computedExpirationDate: string;
  overrideExpirationDate?: string;
  source: ItemSource;
  createdAt: string;
  updatedAt: string;
};

export type ParsedReceiptItem = {
  rawLine: string;
  canonicalName: string;
  displayName: string;
  quantity: number;
  unit: string;
  confidence: number;
};

export type RankedIngredient = {
  canonicalName: string;
  displayName: string;
  daysUntilExpiration: number;
  urgencyScore: number;
};

export type RecipeSuggestion = {
  title: string;
  pantryIngredientsUsed: string[];
  missingIngredients: string[];
  steps: string[];
  estimatedCookingTimeMinutes: number;
};
