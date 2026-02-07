import { NextResponse } from 'next/server';
import { canonicalizeIngredient } from '@/lib/shelfLife';
import type { ParsedReceiptItem } from '@/lib/types';

type OcrRequest = {
  imageDataUrl?: string;
};

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing OPENAI_API_KEY environment variable.' }, { status: 500 });
    }

    const model = process.env.OPENAI_OCR_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const body = (await request.json()) as OcrRequest;
    const imageDataUrl = body.imageDataUrl?.trim();

    if (!imageDataUrl) {
      return NextResponse.json({ error: 'imageDataUrl is required.' }, { status: 400 });
    }

    if (!imageDataUrl.startsWith('data:image/')) {
      return NextResponse.json(
        { error: 'imageDataUrl must be a valid data URL with an image MIME type.' },
        { status: 400 },
      );
    }

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
              'Exclude store names, addresses, dates, payment info, subtotal, tax, total, loyalty lines, coupons, and non-item metadata.',
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
              required: ['items'],
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return NextResponse.json({ error: `OpenAI OCR failed: ${detail}` }, { status: 502 });
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return NextResponse.json({ error: 'No OCR text returned from model.' }, { status: 502 });
    }

    let parsed: { items?: unknown } | null = null;
    try {
      parsed = JSON.parse(content) as { items?: unknown };
    } catch {
      parsed = null;
    }

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
        } satisfies ParsedReceiptItem;
      })
      .filter((value): value is ParsedReceiptItem => value !== null);

    if (items.length === 0) {
      return NextResponse.json(
        { error: 'No grocery items with quantity/unit were extracted from the receipt.' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      items,
      groceryLines: items.map((item) => item.rawLine),
      rawText: items.map((item) => item.rawLine).join('\n'),
      model,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Could not run OCR at this time.',
      },
      { status: 500 },
    );
  }
}
