'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { NOTIFIED_STORAGE_KEY } from '@/lib/constants';
import { createInventoryItem, loadPantryFromStorage, savePantryToStorage } from '@/lib/pantry';
import { canonicalizeIngredient, daysUntil } from '@/lib/shelfLife';
import type { InventoryItem, RankedIngredient, RecipeSuggestion } from '@/lib/types';

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function toDateInputValue(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

type RecipeApiPayload = {
  recipes?: RecipeSuggestion[];
  rankedIngredients?: RankedIngredient[];
  source?: 'openai' | 'fallback';
  warning?: string;
  error?: string;
};

type ShelfLifeApiPayload = {
  shelfLifeByCanonical?: Record<string, number>;
  provider?: 'openai' | 'fallback';
  warning?: string;
  debug?: {
    openaiRequestAttempted: boolean;
    openaiResponseOk: boolean;
    openaiMatchedItems: number;
  };
  error?: string;
};

export default function HomePage() {
  const [ingredients, setIngredients] = useState<InventoryItem[]>([]);
  const [hasHydratedPantry, setHasHydratedPantry] = useState(false);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [editQuantity, setEditQuantity] = useState<Record<string, string>>({});
  const [editExpiration, setEditExpiration] = useState<Record<string, string>>({});
  const [openEditorId, setOpenEditorId] = useState<string | null>(null);
  const [recipes, setRecipes] = useState<RecipeSuggestion[]>([]);
  const [rankedIngredients, setRankedIngredients] = useState<RankedIngredient[]>([]);
  const [recipeSource, setRecipeSource] = useState<'openai' | 'fallback' | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAddingIngredient, setIsAddingIngredient] = useState(false);
  const [preferences, setPreferences] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function syncPantryFromStorage() {
      setIngredients(loadPantryFromStorage());
    }

    syncPantryFromStorage();
    setHasHydratedPantry(true);

    window.addEventListener('pantry:updated', syncPantryFromStorage);
    window.addEventListener('storage', syncPantryFromStorage);
    window.addEventListener('focus', syncPantryFromStorage);

    return () => {
      window.removeEventListener('pantry:updated', syncPantryFromStorage);
      window.removeEventListener('storage', syncPantryFromStorage);
      window.removeEventListener('focus', syncPantryFromStorage);
    };
  }, []);

  useEffect(() => {
    if (!hasHydratedPantry) return;
    savePantryToStorage(ingredients, { emitEvent: false });
  }, [ingredients, hasHydratedPantry]);

  const sortedIngredients = useMemo(() => {
    return [...ingredients].sort((a, b) => {
      const aExpiration = a.overrideExpirationDate ?? a.computedExpirationDate;
      const bExpiration = b.overrideExpirationDate ?? b.computedExpirationDate;
      return daysUntil(aExpiration) - daysUntil(bExpiration);
    });
  }, [ingredients]);

  const expiringSoon = useMemo(() => {
    return sortedIngredients.filter(
      (item) => daysUntil(item.overrideExpirationDate ?? item.computedExpirationDate) <= 2,
    );
  }, [sortedIngredients]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const notifiedRaw = window.localStorage.getItem(NOTIFIED_STORAGE_KEY);
    const notified = notifiedRaw ? (JSON.parse(notifiedRaw) as Record<string, string>) : {};
    let changed = false;

    for (const item of expiringSoon) {
      const effectiveExpiration = item.overrideExpirationDate ?? item.computedExpirationDate;
      if (notified[item.id] === effectiveExpiration) continue;

      const remaining = daysUntil(effectiveExpiration);
      const label =
        remaining < 0 ? `${Math.abs(remaining)} day(s) overdue` : `${remaining} day(s) left`;

      new Notification('Kitchen Knightmare', {
        body: `${item.displayName} is nearing expiration (${label}).`,
      });

      notified[item.id] = effectiveExpiration;
      changed = true;
    }

    if (changed) {
      window.localStorage.setItem(NOTIFIED_STORAGE_KEY, JSON.stringify(notified));
    }
  }, [expiringSoon]);

  async function addIngredient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!name.trim() || !quantity.trim()) {
      setError('Ingredient name and quantity are required.');
      return;
    }

    const parsedQuantity = Number(quantity);
    if (Number.isNaN(parsedQuantity) || parsedQuantity <= 0) {
      setError('Quantity must be a positive number.');
      return;
    }

    try {
      setIsAddingIngredient(true);
      const ingredientName = name.trim();
      const expirationDateOverride = expirationDate ? new Date(expirationDate).toISOString() : undefined;
      const { canonicalName } = canonicalizeIngredient(ingredientName);

      let shelfLifeDaysOverride: number | undefined;
      if (!expirationDateOverride) {
        console.info('[client] request', {
          endpoint: '/api/shelf-life',
          item: ingredientName,
          canonicalName,
        });
        const shelfLifeResponse = await fetch('/api/shelf-life', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [{ name: ingredientName, canonicalName }],
          }),
        });
        console.info('[client] response', {
          endpoint: '/api/shelf-life',
          status: shelfLifeResponse.status,
          ok: shelfLifeResponse.ok,
        });

        const shelfLifePayload = (await shelfLifeResponse.json()) as ShelfLifeApiPayload;
        console.info('[client] shelf-life payload', {
          provider: shelfLifePayload.provider,
          warning: shelfLifePayload.warning,
          debug: shelfLifePayload.debug,
        });
        if (!shelfLifeResponse.ok) {
          throw new Error(shelfLifePayload.error ?? 'Could not estimate shelf life.');
        }

        shelfLifeDaysOverride = shelfLifePayload.shelfLifeByCanonical?.[canonicalName];
      }

      const newItem = createInventoryItem({
        name: ingredientName,
        quantity: parsedQuantity,
        unit: unit.trim() || 'item',
        source: 'manual',
        expirationDateOverride,
        shelfLifeDaysOverride,
      });

      setIngredients((prev) => [newItem, ...prev]);
      setName('');
      setQuantity('');
      setUnit('');
      setExpirationDate('');
      setError(null);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Could not add ingredient.');
    } finally {
      setIsAddingIngredient(false);
    }
  }

  function removeIngredient(id: string) {
    setIngredients((prev) => prev.filter((ingredient) => ingredient.id !== id));
    setOpenEditorId((prev) => (prev === id ? null : prev));
  }

  function confirmAndRemoveIngredient(id: string, displayName: string) {
    const confirmed = window.confirm(`Delete "${displayName}" from pantry?`);
    if (!confirmed) return;
    removeIngredient(id);
  }

  function saveItemEdits(id: string) {
    const current = ingredients.find((item) => item.id === id);
    if (!current) return;

    const nextQuantityValue = editQuantity[id] ?? String(current.quantity);
    const nextExpirationValue =
      editExpiration[id] ?? toDateInputValue(current.overrideExpirationDate ?? current.computedExpirationDate);

    const nextQuantity = Number(nextQuantityValue);
    if (Number.isNaN(nextQuantity) || nextQuantity <= 0) {
      setError('Edited quantity must be a positive number.');
      return;
    }

    setIngredients((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        return {
          ...item,
          quantity: nextQuantity,
          overrideExpirationDate: nextExpirationValue
            ? new Date(nextExpirationValue).toISOString()
            : undefined,
          updatedAt: new Date().toISOString(),
        };
      }),
    );
    setError(null);
  }

  async function generateRecipe() {
    if (ingredients.length === 0) {
      setError('Add ingredients before generating recipes.');
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      console.info('[client] request', {
        endpoint: '/api/recipes',
        pantryCount: ingredients.length,
        hasPreferences: Boolean(preferences.trim()),
      });
      const response = await fetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pantry: ingredients, preferences }),
      });
      console.info('[client] response', {
        endpoint: '/api/recipes',
        status: response.status,
        ok: response.ok,
      });

      const payload = (await response.json()) as RecipeApiPayload;
      if (!response.ok) {
        throw new Error(payload.error ?? 'Recipe generation failed.');
      }

      setRecipes(payload.recipes ?? []);
      setRankedIngredients(payload.rankedIngredients ?? []);
      setRecipeSource(payload.source ?? null);

      if (payload.warning) {
        setError(payload.warning);
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Could not generate recipes at this time.',
      );
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <h1 className="eyebrow">Kitchen Knightmare</h1>
        <p>
          Manage inventory, import receipt items, and generate recipes that prioritize what expires
          first.
        </p>
        <div className="heroActions">
          <Link href="/scan" className="ghostButton">
            Receipt scanner
          </Link>
        </div>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Add ingredient</h2>
          <form onSubmit={addIngredient} className="formStack">
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              Quantity
              <input
                type="number"
                min="0"
                step="0.01"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <label>
              Unit
              <input
                placeholder="kg, L, item"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
              />
            </label>
            <label>
              Expiration override (optional)
              <input
                type="date"
                value={expirationDate}
                onChange={(event) => setExpirationDate(event.target.value)}
              />
            </label>
            <button type="submit" className="primaryButton" disabled={isAddingIngredient}>
              {isAddingIngredient ? 'Adding...' : 'Add to pantry'}
            </button>
          </form>
        </article>

        <article className="panel pantryPanel">
          <h2>My pantry</h2>
          <div className="pantryContent">
            {sortedIngredients.length === 0 ? (
              <p className="muted">No ingredients yet.</p>
            ) : (
              <ul className="ingredientList">
                {sortedIngredients.map((ingredient) => {
                  const effectiveExpiration =
                    ingredient.overrideExpirationDate ?? ingredient.computedExpirationDate;
                  const remainingDays = daysUntil(effectiveExpiration);
                  const badgeClass =
                    remainingDays < 0 ? 'expired' : remainingDays <= 3 ? 'warning' : 'good';

                  return (
                    <li key={ingredient.id} className="ingredientCard">
                      <div className="ingredientMain">
                        <p className="ingredientTitle">
                          {ingredient.displayName} ({ingredient.canonicalName})
                        </p>
                        <p className="muted">
                          Bought {formatDate(ingredient.purchaseDate)} · source: {ingredient.source}
                        </p>
                        {openEditorId === ingredient.id ? (
                          <div className="inlineEdits">
                            <label>
                              Qty
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={editQuantity[ingredient.id] ?? String(ingredient.quantity)}
                                onChange={(event) =>
                                  setEditQuantity((prev) => ({
                                    ...prev,
                                    [ingredient.id]: event.target.value,
                                  }))
                                }
                              />
                            </label>
                            <label>
                              Expiration
                              <input
                                type="date"
                                value={
                                  editExpiration[ingredient.id] ?? toDateInputValue(effectiveExpiration)
                                }
                                onChange={(event) =>
                                  setEditExpiration((prev) => ({
                                    ...prev,
                                    [ingredient.id]: event.target.value,
                                  }))
                                }
                              />
                            </label>
                            <div className="editActions">
                              <button
                                type="button"
                                className="primaryButton"
                                onClick={() => saveItemEdits(ingredient.id)}
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <div className="actions compact">
                        <span className={`statusBadge ${badgeClass}`}>
                          {remainingDays < 0
                            ? `${Math.abs(remainingDays)} days late`
                            : `${remainingDays} days left`}
                        </span>
                        <button
                          type="button"
                          className="iconButton"
                          aria-label={`Edit ${ingredient.displayName}`}
                          onClick={() =>
                            setOpenEditorId((prev) => (prev === ingredient.id ? null : ingredient.id))
                          }
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="iconButton deleteIconButton"
                          aria-label={`Delete ${ingredient.displayName}`}
                          onClick={() =>
                            confirmAndRemoveIngredient(ingredient.id, ingredient.displayName)
                          }
                        >
                          🗑
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </article>
      </section>

      <section className="panel recipePanel">
        <div className="recipeHeader">
          <h2>Recipe recommendations</h2>
          <button
            type="button"
            className="primaryButton"
            onClick={generateRecipe}
            disabled={isGenerating}
          >
            {isGenerating ? 'Generating...' : 'Generate 3-5 recipes'}
          </button>
        </div>

        <label>
          Preferences (optional)
          <input
            placeholder="High protein, vegetarian, avoid spicy..."
            value={preferences}
            onChange={(event) => setPreferences(event.target.value)}
          />
        </label>

        {rankedIngredients.length > 0 ? (
          <div className="rankedList">
            <p className="muted">Urgency ranking:</p>
            <p>
              {rankedIngredients
                .slice(0, 6)
                .map((item) => `${item.displayName} (${item.daysUntilExpiration}d)`)
                .join(' · ')}
            </p>
          </div>
        ) : null}

        {recipes.length > 0 ? (
          <div className="recipeCards">
            {recipes.map((recipe) => (
              <article key={recipe.title} className="recipeCard">
                <h3>{recipe.title}</h3>
                <p>
                  <strong>Pantry used:</strong> {recipe.pantryIngredientsUsed.join(', ') || 'None'}
                </p>
                <p>
                  <strong>Missing:</strong> {recipe.missingIngredients.join(', ') || 'None'}
                </p>
                <p>
                  <strong>Time:</strong> {recipe.estimatedCookingTimeMinutes} min
                </p>
                <ol>
                  {recipe.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No recipes generated yet.</p>
        )}

        {recipeSource ? <p className="muted">Recipe source: {recipeSource}</p> : null}
      </section>

      {error ? <p className="errorText">{error}</p> : null}
    </main>
  );
}
