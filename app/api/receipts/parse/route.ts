import { NextResponse } from 'next/server';
import { parseReceiptText } from '@/lib/receiptParser';

type ParseReceiptRequest = {
  rawText?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ParseReceiptRequest;
    const rawText = body.rawText?.trim() ?? '';

    if (!rawText) {
      return NextResponse.json({ error: 'rawText is required.' }, { status: 400 });
    }

    const items = parseReceiptText(rawText);

    return NextResponse.json({
      items,
      totalParsedLines: items.length,
    });
  } catch (error) {
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
