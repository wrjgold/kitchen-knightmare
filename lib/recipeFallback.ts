import { daysUntil, urgencyScore } from '@/lib/shelfLife';
import type { InventoryItem, RankedIngredient, RecipeSuggestion } from '@/lib/types';

export function rankExpiringIngredients(pantry: InventoryItem[]): RankedIngredient[] {
  return pantry
    .map((item) => {
      const effectiveExpiration = item.overrideExpirationDate ?? item.computedExpirationDate;
      const remaining = daysUntil(effectiveExpiration);
      return {
        canonicalName: item.canonicalName,
        displayName: item.displayName,
        daysUntilExpiration: remaining,
        urgencyScore: urgencyScore(remaining),
      };
    })
    .sort((a, b) => b.urgencyScore - a.urgencyScore || a.daysUntilExpiration - b.daysUntilExpiration);
}

export function fallbackRecipes(pantry: InventoryItem[]): RecipeSuggestion[] {
  const ranked = rankExpiringIngredients(pantry);
  const top = ranked.slice(0, 6).map((item) => item.canonicalName);
  const inventorySet = new Set(pantry.map((item) => item.canonicalName));

  const templates: RecipeSuggestion[] = [
    {
      title: 'Quick Stir-Fry Rescue',
      pantryIngredientsUsed: top.slice(0, 4),
      missingIngredients: ['soy sauce', 'oil'].filter((x) => !inventorySet.has(x)),
      steps: [
        'Chop all produce and proteins into bite-sized pieces.',
        'Heat oil in a pan, cook proteins first, then add vegetables.',
        'Add soy sauce and cook until tender-crisp.',
        'Serve hot over bread, rice, or as-is.',
      ],
      estimatedCookingTimeMinutes: 20,
    },
    {
      title: 'Pantry Omelet Bowl',
      pantryIngredientsUsed: top.filter((i) => i !== 'fish').slice(0, 3),
      missingIngredients: ['salt', 'pepper'].filter((x) => !inventorySet.has(x)),
      steps: [
        'Whisk eggs with a splash of milk if available.',
        'Saute chopped expiring vegetables until soft.',
        'Pour eggs over vegetables and cook until set.',
        'Fold and serve with toast or salad.',
      ],
      estimatedCookingTimeMinutes: 15,
    },
    {
      title: 'Roasted Tray Mix',
      pantryIngredientsUsed: top.slice(0, 5),
      missingIngredients: ['olive oil', 'salt'].filter((x) => !inventorySet.has(x)),
      steps: [
        'Preheat oven to 425F.',
        'Cut ingredients evenly and toss with oil and seasoning.',
        'Spread on tray and roast 20-30 minutes.',
        'Finish with a squeeze of lemon or herbs if available.',
      ],
      estimatedCookingTimeMinutes: 35,
    },
    {
      title: 'Soup Pot Save',
      pantryIngredientsUsed: top.slice(0, 4),
      missingIngredients: ['broth'].filter((x) => !inventorySet.has(x)),
      steps: [
        'Add chopped ingredients to a pot with broth or water.',
        'Simmer until everything is tender.',
        'Season and blend partially for texture.',
        'Serve warm and store leftovers.',
      ],
      estimatedCookingTimeMinutes: 30,
    },
    {
      title: 'Cold Leftover Salad',
      pantryIngredientsUsed: top.slice(0, 3),
      missingIngredients: ['vinegar', 'olive oil'].filter((x) => !inventorySet.has(x)),
      steps: [
        'Slice all fresh ingredients thinly.',
        'Whisk quick dressing from oil, vinegar, salt.',
        'Combine and rest for 5 minutes.',
        'Top with protein or cheese if available.',
      ],
      estimatedCookingTimeMinutes: 10,
    },
  ];

  return templates
    .map((recipe) => ({
      ...recipe,
      pantryIngredientsUsed: recipe.pantryIngredientsUsed.filter(Boolean),
    }))
    .filter((recipe) => recipe.pantryIngredientsUsed.length > 0)
    .slice(0, 5);
}
