import { NextResponse } from 'next/server';
import { canonicalizeIngredient, getShelfLifeDays } from '@/lib/shelfLife';

type ShelfLifeRequestItem = {
  name?: string;
  canonicalName?: string;
};

type ShelfLifeRequest = {
  items?: ShelfLifeRequestItem[];
};

type ShelfLifeResponse = {
  shelfLifeByCanonical: Record<string, number>;
  provider: 'openai' | 'fallback';
  warning?: string;
  debug?: {
    openaiRequestAttempted: boolean;
    openaiResponseOk: boolean;
    openaiMatchedItems: number;
  };
};

type OpenAiShelfLifeItem = {
  canonicalName?: string;
  shelfLifeDays?: number;
};

function clampShelfLifeDays(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < 1 || rounded > 365) return null;
  return rounded;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

function normalizeItems(rawItems: ShelfLifeRequestItem[]): Array<{ canonicalName: string; displayName: string }> {
  const unique = new Map<string, string>();

  for (const item of rawItems) {
    const itemName = typeof item.name === 'string' ? item.name.trim() : '';
    const inputCanonical = typeof item.canonicalName === 'string' ? item.canonicalName.trim() : '';
    const canonicalName = inputCanonical || canonicalizeIngredient(itemName).canonicalName;
    const normalizedCanonical = canonicalName.trim().toLowerCase();
    if (!normalizedCanonical) continue;
    if (unique.has(normalizedCanonical)) continue;
    unique.set(normalizedCanonical, itemName || normalizedCanonical);
  }

  return Array.from(unique.entries()).map(([canonicalName, displayName]) => ({
    canonicalName,
    displayName,
  }));
}

function buildFallbackShelfLife(items: Array<{ canonicalName: string }>): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.canonicalName] = getShelfLifeDays(item.canonicalName);
    return acc;
  }, {});
}

function extractOpenAIText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';

  const source = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>;
  };

  if (typeof source.output_text === 'string') {
    return source.output_text;
  }

  const output = Array.isArray(source.output) ? source.output : [];
  return output
    .flatMap((block) => (Array.isArray(block.content) ? block.content : []))
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const typedPart = part as { type?: unknown; text?: unknown };
      if (
        (typedPart.type === 'output_text' || typedPart.type === 'text') &&
        typeof typedPart.text === 'string'
      ) {
        return typedPart.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID().slice(0, 8);
  try {
    const body = (await request.json()) as ShelfLifeRequest;
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items = normalizeItems(rawItems).slice(0, 30);
    console.info('[api/shelf-life] request', {
      requestId,
      rawItems: rawItems.length,
      normalizedItems: items.length,
    });

    if (items.length === 0) {
      console.warn('[api/shelf-life] response', {
        requestId,
        status: 400,
        error: 'items is required.',
      });
      return NextResponse.json({ error: 'items is required.' }, { status: 400 });
    }

    const fallback = buildFallbackShelfLife(items);
    const openaiApiKey = process.env.OPENAI_API_KEY;
    const debug = {
      openaiRequestAttempted: false,
      openaiResponseOk: false,
      openaiMatchedItems: 0,
    };

    if (!openaiApiKey) {
      const response: ShelfLifeResponse = {
        shelfLifeByCanonical: fallback,
        provider: 'fallback',
        warning: 'OPENAI_API_KEY is not configured, using local shelf-life defaults.',
        debug,
      };
      console.warn('[api/shelf-life] response', {
        requestId,
        status: 200,
        provider: 'fallback',
        reason: 'missing OPENAI_API_KEY',
        debug,
      });
      return NextResponse.json(response);
    }

    const prompt = [
      'Find typical refrigerated shelf life in days for each grocery ingredient using current web sources.',
      'Return strict JSON only with this shape:',
      '{"items":[{"canonicalName":"milk","shelfLifeDays":7}]}',
      'Rules:',
      '- canonicalName must match one of the requested canonical names exactly.',
      '- shelfLifeDays must be an integer between 1 and 365.',
      '- no prose, markdown, or extra fields.',
      '',
      'Ingredients:',
      ...items.map((item) => `- ${item.canonicalName} (${item.displayName})`),
    ].join('\n');

    debug.openaiRequestAttempted = true;
    console.info('[api/shelf-life] outbound', {
      requestId,
      target: 'openai.responses',
      model: process.env.OPENAI_SHELF_LIFE_MODEL || 'gpt-4.1-mini',
      tool: 'web_search_preview',
      itemCount: items.length,
    });

    const openAiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_SHELF_LIFE_MODEL || 'gpt-4.1-mini',
        tools: [{ type: 'web_search' }],
        input: prompt,
      }),
    });

    console.info('[api/shelf-life] inbound', {
      requestId,
      source: 'openai.responses',
      status: openAiResponse.status,
      ok: openAiResponse.ok,
    });

    if (!openAiResponse.ok) {
      const detail = await openAiResponse.text();
      const response: ShelfLifeResponse = {
        shelfLifeByCanonical: fallback,
        provider: 'fallback',
        warning: `OpenAI web search failed: ${detail}`,
        debug,
      };
      console.warn('[api/shelf-life] response', {
        requestId,
        status: 200,
        provider: 'fallback',
        reason: `openai status ${openAiResponse.status}`,
        debug,
      });
      return NextResponse.json(response);
    }
    debug.openaiResponseOk = true;

    const openAiPayload = (await openAiResponse.json()) as unknown;
    console.info('[api/shelf-life] openai raw response', {
      requestId,
      payload: openAiPayload,
    });

    const contentText = extractOpenAIText(openAiPayload);
    const parsedObject = parseJsonObject(contentText);
    const parsedItemsRaw = parsedObject?.items;
    const parsedItems = Array.isArray(parsedItemsRaw) ? (parsedItemsRaw as OpenAiShelfLifeItem[]) : [];

    const shelfLifeByCanonical = { ...fallback };
    for (const parsedItem of parsedItems) {
      const canonicalNameRaw =
        typeof parsedItem.canonicalName === 'string' ? parsedItem.canonicalName.trim().toLowerCase() : '';
      if (!canonicalNameRaw || !(canonicalNameRaw in shelfLifeByCanonical)) continue;
      const shelfLifeDays = clampShelfLifeDays(parsedItem.shelfLifeDays);
      if (shelfLifeDays === null) continue;
      shelfLifeByCanonical[canonicalNameRaw] = shelfLifeDays;
      debug.openaiMatchedItems += 1;
    }

    const warning =
      debug.openaiMatchedItems === 0
        ? 'OpenAI web search returned no usable shelf-life values; fallback defaults were used.'
        : undefined;

    const response: ShelfLifeResponse = {
      shelfLifeByCanonical,
      provider: 'openai',
      warning,
      debug,
    };
    console.info('[api/shelf-life] response', {
      requestId,
      status: 200,
      provider: 'openai',
      warning: warning ?? null,
      debug,
    });
    return NextResponse.json(response);
  } catch (error) {
    console.error('[api/shelf-life] response', {
      requestId,
      status: 500,
      error: error instanceof Error ? error.message : 'Could not estimate shelf life at this time.',
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Could not estimate shelf life at this time.',
      },
      { status: 500 },
    );
  }
}
