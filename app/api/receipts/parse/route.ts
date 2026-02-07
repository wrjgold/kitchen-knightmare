import { NextResponse } from 'next/server';
import { parseReceiptText } from '@/lib/receiptParser';

type ParseReceiptRequest = {
  rawText?: string;
};

export async function POST(request: Request) {
  const requestId = crypto.randomUUID().slice(0, 8);
  try {
    const body = (await request.json()) as ParseReceiptRequest;
    const rawText = body.rawText?.trim() ?? '';
    console.info('[api/receipts/parse] request', {
      requestId,
      rawTextLength: rawText.length,
    });

    if (!rawText) {
      console.warn('[api/receipts/parse] response', {
        requestId,
        status: 400,
        error: 'rawText is required.',
      });
      return NextResponse.json({ error: 'rawText is required.' }, { status: 400 });
    }

    const items = parseReceiptText(rawText);
    console.info('[api/receipts/parse] response', {
      requestId,
      status: 200,
      parsedItems: items.length,
    });

    return NextResponse.json({
      items,
      totalParsedLines: items.length,
    });
  } catch (error) {
    console.error('[api/receipts/parse] response', {
      requestId,
      status: 500,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Could not parse receipt text. Please try again.',
      },
      { status: 500 },
    );
  }
}
