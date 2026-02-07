import { NextResponse } from 'next/server';
import { canonicalizeIngredient } from '@/lib/shelfLife';
import type { ParsedReceiptItem } from '@/lib/types';

type OcrRequest = {
  imageDataUrl?: string;
};

function normalizePurchaseDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID().slice(0, 8);
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('[api/receipts/ocr] response', {
        requestId,
        status: 500,
        error: 'Missing OPENAI_API_KEY environment variable.',
      });
      return NextResponse.json({ error: 'Missing OPENAI_API_KEY environment variable.' }, { status: 500 });
    }

    const model = process.env.OPENAI_OCR_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const body = (await request.json()) as OcrRequest;
    const imageDataUrl = body.imageDataUrl?.trim();
    console.info('[api/receipts/ocr] request', {
      requestId,
      hasImageDataUrl: Boolean(imageDataUrl),
      imagePrefix: imageDataUrl?.slice(0, 30),
    });

    if (!imageDataUrl) {
      console.warn('[api/receipts/ocr] response', {
        requestId,
        status: 400,
        error: 'imageDataUrl is required.',
      });
      return NextResponse.json({ error: 'imageDataUrl is required.' }, { status: 400 });
    }

    if (!imageDataUrl.startsWith('data:image/')) {
      console.warn('[api/receipts/ocr] response', {
        requestId,
        status: 400,
        error: 'imageDataUrl must be a valid data URL with an image MIME type.',
      });
      return NextResponse.json(
        { error: 'imageDataUrl must be a valid data URL with an image MIME type.' },
        { status: 400 },
      );
    }
    console.info('[api/receipts/ocr] outbound', {
      requestId,
      target: 'openai.chat.completions',
      model,
    });

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
            content: [
              'You extract only grocery line items from receipt images as structured JSON.',
              'Return only purchased food/grocery product lines with quantity and unit.',
              'Extract receipt purchase date as purchaseDate in ISO date format YYYY-MM-DD if visible, otherwise null.',
              'Exclude store names, addresses, payment info, subtotal, tax, total, loyalty lines, coupons, and non-item metadata.',
              'Use quantity as a number. If missing, use 1.',
              "Use unit like 'item', 'lb', 'kg', 'oz', 'l', 'ml', 'pack'. If missing, use 'item'.",
              'Keep rawLine concise and close to receipt wording.',
              'Do not add explanations.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract only grocery items. Include name, quantity, unit, and raw line text.',
              },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'receipt_grocery_items',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                purchaseDate: { type: ['string', 'null'] },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string' },
                      quantity: { type: 'number' },
                      unit: { type: 'string' },
                      rawLine: { type: 'string' },
                    },
                    required: ['name', 'quantity', 'unit', 'rawLine'],
                  },
                },
              },
              required: ['purchaseDate', 'items'],
            },
          },
        },
      }),
    });
    console.info('[api/receipts/ocr] inbound', {
      requestId,
      source: 'openai.chat.completions',
      status: response.status,
      ok: response.ok,
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('[api/receipts/ocr] response', {
        requestId,
        status: 502,
        error: `OpenAI OCR failed: ${detail}`,
      });
      return NextResponse.json({ error: `OpenAI OCR failed: ${detail}` }, { status: 502 });
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      console.error('[api/receipts/ocr] response', {
        requestId,
        status: 502,
        error: 'No OCR text returned from model.',
      });
      return NextResponse.json({ error: 'No OCR text returned from model.' }, { status: 502 });
    }

    let parsed: { purchaseDate?: unknown; items?: unknown } | null = null;
    try {
      parsed = JSON.parse(content) as { purchaseDate?: unknown; items?: unknown };
    } catch {
      parsed = null;
    }

    const purchaseDate = normalizePurchaseDate(parsed?.purchaseDate);
    const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
    const items: ParsedReceiptItem[] = rawItems
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const candidate = entry as Record<string, unknown>;
        const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        const quantityRaw = candidate.quantity;
        const quantity = typeof quantityRaw === 'number' ? quantityRaw : Number(quantityRaw);
        const unit = typeof candidate.unit === 'string' ? candidate.unit.trim() : '';
        const rawLine = typeof candidate.rawLine === 'string' ? candidate.rawLine.trim() : name;

        if (!name || !Number.isFinite(quantity) || quantity <= 0) return null;
        const { canonicalName, confidence } = canonicalizeIngredient(name);

        return {
          rawLine: rawLine || name,
          canonicalName,
          displayName: name,
          quantity,
          unit: unit || 'item',
          confidence,
          ...(purchaseDate ? { purchaseDate } : {}),
        } satisfies ParsedReceiptItem;
      })
      .filter((value): value is ParsedReceiptItem => value !== null);

    if (items.length === 0) {
      console.warn('[api/receipts/ocr] response', {
        requestId,
        status: 502,
        error: 'No grocery items with quantity/unit were extracted from the receipt.',
      });
      return NextResponse.json(
        { error: 'No grocery items with quantity/unit were extracted from the receipt.' },
        { status: 502 },
      );
    }
    console.info('[api/receipts/ocr] response', {
      requestId,
      status: 200,
      purchaseDate: purchaseDate ?? null,
      itemCount: items.length,
    });

    return NextResponse.json({
      purchaseDate,
      items,
      groceryLines: items.map((item) => item.rawLine),
      rawText: items.map((item) => item.rawLine).join('\n'),
      model,
    });
  } catch (error) {
    console.error('[api/receipts/ocr] response', {
      requestId,
      status: 500,
      error: error instanceof Error ? error.message : 'Could not run OCR at this time.',
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Could not run OCR at this time.',
      },
      { status: 500 },
    );
  }
}
