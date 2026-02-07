const DEFAULT_SHELF_LIFE_DAYS = 7;

const SHELF_LIFE_BY_INGREDIENT: Record<string, number> = {
  apple: 30,
  banana: 5,
  beef: 4,
  bread: 7,
  broccoli: 7,
  butter: 30,
  carrot: 21,
  cheese: 28,
  chicken: 2,
  cilantro: 4,
  cucumber: 7,
  egg: 21,
  fish: 2,
  garlic: 45,
  lettuce: 7,
  milk: 7,
  onion: 30,
  potato: 30,
  spinach: 5,
  tomato: 10,
  yogurt: 14,
};

const INGREDIENT_ALIASES: Record<string, string> = {
  apples: 'apple',
  bananas: 'banana',
  eggs: 'egg',
  tomatoes: 'tomato',
  potatoes: 'potato',
  onions: 'onion',
  lettuces: 'lettuce',
  bnna: 'banana',
  orgbnna: 'banana',
  mlk: 'milk',
  chk: 'chicken',
  chkn: 'chicken',
  tom: 'tomato',
  yog: 'yogurt',
};

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let col = 0; col < cols; col += 1) matrix[0][col] = col;

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost,
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

export function canonicalizeIngredient(rawName: string): { canonicalName: string; confidence: number } {
  const normalized = normalizeToken(rawName);
  if (!normalized) {
    return { canonicalName: 'unknown', confidence: 0 };
  }

  const aliasMatch = INGREDIENT_ALIASES[normalized];
  if (aliasMatch) {
    return { canonicalName: aliasMatch, confidence: 0.95 };
  }

  if (SHELF_LIFE_BY_INGREDIENT[normalized]) {
    return { canonicalName: normalized, confidence: 1 };
  }

  let bestMatch = 'unknown';
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const key of Object.keys(SHELF_LIFE_BY_INGREDIENT)) {
    const distance = levenshteinDistance(normalized, key);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = key;
    }
  }

  const maxLength = Math.max(bestMatch.length, normalized.length);
  const similarity = maxLength === 0 ? 0 : 1 - bestDistance / maxLength;

  if (similarity >= 0.55) {
    return { canonicalName: bestMatch, confidence: Number(similarity.toFixed(2)) };
  }

  return { canonicalName: normalized, confidence: 0.5 };
}

export function getShelfLifeDays(canonicalName: string): number {
  return SHELF_LIFE_BY_INGREDIENT[canonicalName] ?? DEFAULT_SHELF_LIFE_DAYS;
}

export function estimateExpirationDate(
  ingredientName: string,
  purchaseDateIso: string = new Date().toISOString(),
): string {
  const { canonicalName } = canonicalizeIngredient(ingredientName);
  const shelfLifeDays = getShelfLifeDays(canonicalName);
  const expiration = new Date(purchaseDateIso);
  expiration.setDate(expiration.getDate() + shelfLifeDays);
  return expiration.toISOString();
}

export function expirationDateForItem(params: {
  canonicalName: string;
  purchaseDate: string;
  overrideExpirationDate?: string;
}): string {
  const { canonicalName, purchaseDate, overrideExpirationDate } = params;
  if (overrideExpirationDate) {
    return new Date(overrideExpirationDate).toISOString();
  }

  const expiration = new Date(purchaseDate);
  expiration.setDate(expiration.getDate() + getShelfLifeDays(canonicalName));
  return expiration.toISOString();
}

export function daysUntil(dateIso: string): number {
  const now = Date.now();
  const target = new Date(dateIso).getTime();
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

export function urgencyScore(daysUntilExpiration: number): number {
  return Math.max(0, 7 - daysUntilExpiration);
}
