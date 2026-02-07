import { NextResponse } from 'next/server';
import { fallbackRecipes, rankExpiringIngredients } from '@/lib/recipeFallback';
import type { InventoryItem, RecipeSuggestion } from '@/lib/types';

type RecipeRequest = {
  pantry?: InventoryItem[];
  preferences?: string;
};

type RecipeResponse = {
  recipes: RecipeSuggestion[];
  rankedIngredients: ReturnType<typeof rankExpiringIngredients>;
  source: 'openai' | 'fallback';
};

function validateRecipes(raw: unknown): RecipeSuggestion[] {
  if (!Array.isArray(raw)) return [];

  const valid = raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const candidate = item as Record<string, unknown>;

      if (
        typeof candidate.title !== 'string' ||
        !Array.isArray(candidate.pantryIngredientsUsed) ||
        !Array.isArray(candidate.missingIngredients) ||
        !Array.isArray(candidate.steps) ||
        typeof candidate.estimatedCookingTimeMinutes !== 'number'
      ) {
        return null;
      }

      return {
        title: candidate.title,
        pantryIngredientsUsed: candidate.pantryIngredientsUsed.filter(
          (value): value is string => typeof value === 'string',
        ),
        missingIngredients: candidate.missingIngredients.filter(
          (value): value is string => typeof value === 'string',
        ),
        steps: candidate.steps.filter((value): value is string => typeof value === 'string'),
        estimatedCookingTimeMinutes: candidate.estimatedCookingTimeMinutes,
      } satisfies RecipeSuggestion;
    })
    .filter((value): value is RecipeSuggestion => value !== null)
    .slice(0, 5);

  return valid;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RecipeRequest;
    const pantry = body.pantry ?? [];

    if (!Array.isArray(pantry) || pantry.length === 0) {
      return NextResponse.json({ error: 'Pantry inventory is required.' }, { status: 400 });
    }

    const ranked = rankExpiringIngredients(pantry).slice(0, 10);
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    if (!apiKey) {
      const fallback = fallbackRecipes(pantry);
      const response: RecipeResponse = {
        recipes: fallback,
        rankedIngredients: ranked,
        source: 'fallback',
      };
      return NextResponse.json(response);
    }

    const prompt = [
      'Generate 3 to 5 recipes as strict JSON only.',
      'Use this schema:',
      '{"recipes":[{"title":"string","pantryIngredientsUsed":["string"],"missingIngredients":["string"],"steps":["string"],"estimatedCookingTimeMinutes":number}]}',
      'Prioritize ingredients with high urgency first to reduce food waste.',
      `Ranked urgent ingredients: ${JSON.stringify(ranked)}`,
      `Full pantry snapshot: ${JSON.stringify(pantry)}`,
      `User preferences: ${body.preferences?.trim() || 'none'}`,
      'Return JSON only. No markdown fences, no commentary.',
    ].join('\n');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a recipe assistant that returns valid JSON only and prioritizes ingredients close to expiration.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'recipe_suggestions',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                recipes: {
                  type: 'array',
                  minItems: 3,
                  maxItems: 5,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string' },
                      pantryIngredientsUsed: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                      missingIngredients: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                      steps: {
                        type: 'array',
                        minItems: 2,
                        items: { type: 'string' },
                      },
                      estimatedCookingTimeMinutes: { type: 'number' },
                    },
                    required: [
                      'title',
                      'pantryIngredientsUsed',
                      'missingIngredients',
                      'steps',
                      'estimatedCookingTimeMinutes',
                    ],
                  },
                },
              },
              required: ['recipes'],
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const fallback = fallbackRecipes(pantry);
      return NextResponse.json({
        recipes: fallback,
        rankedIngredients: ranked,
        source: 'fallback',
        warning: `OpenAI request failed with status ${response.status}`,
      });
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const rawText = payload.choices?.[0]?.message?.content;
    let parsed: unknown = null;

    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    const recipes = validateRecipes((parsed as { recipes?: unknown })?.recipes);

    if (recipes.length === 0) {
      const fallback = fallbackRecipes(pantry);
      return NextResponse.json({
        recipes: fallback,
        rankedIngredients: ranked,
        source: 'fallback',
        warning: 'Model returned invalid recipe JSON; fallback used.',
      });
    }

    const recipeResponse: RecipeResponse = {
      recipes,
      rankedIngredients: ranked,
      source: 'openai',
    };

    return NextResponse.json(recipeResponse);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Could not generate recipes at this time. Please try again later.',
      },
      { status: 500 },
    );
  }
}
