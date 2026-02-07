import { canonicalizeIngredient } from '@/lib/shelfLife';
import type { ParsedReceiptItem } from '@/lib/types';

const IGNORED_LINE_PATTERNS = [
  /subtotal/i,
  /total/i,
  /tax/i,
  /change/i,
  /cash/i,
  /visa/i,
  /mastercard/i,
  /debit/i,
  /credit/i,
  /thank/i,
  /store/i,
  /receipt/i,
  /date/i,
  /time/i,
  /^\d{1,2}[/:]\d{1,2}/,
  /^[\d\s.,$-]+$/,
];

function cleanLine(line: string): string {
  return line
    .replace(/\s+/g, ' ')
    .replace(/\d+[xX]\s*/g, '')
    .replace(/\$\s*\d+[\d.,]*/g, '')
    .replace(/\b\d+[\d.,]*\b/g, '')
    .trim();
}

function inferUnit(line: string): string {
  if (/\b(lb|lbs|pound|oz)\b/i.test(line)) return 'lb';
  if (/\b(kg|g)\b/i.test(line)) return 'kg';
  if (/\b(l|liter|litre|ml)\b/i.test(line)) return 'l';
  return 'item';
}

function inferQuantity(line: string): number {
  const multiplierMatch = line.match(/(\d+)\s*[xX]/);
  if (multiplierMatch) {
    return Number(multiplierMatch[1]);
  }
  return 1;
}

export function parseReceiptText(rawText: string): ParsedReceiptItem[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed: ParsedReceiptItem[] = [];

  for (const line of lines) {
    if (IGNORED_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      continue;
    }

    const cleaned = cleanLine(line);
    if (!cleaned || cleaned.length < 3) {
      continue;
    }

    const { canonicalName, confidence } = canonicalizeIngredient(cleaned);
    if (canonicalName === 'unknown') {
      continue;
    }

    parsed.push({
      rawLine: line,
      canonicalName,
      displayName: canonicalName,
      quantity: inferQuantity(line),
      unit: inferUnit(line),
      confidence,
    });
  }

  const deduped = new Map<string, ParsedReceiptItem>();

  for (const item of parsed) {
    const key = `${item.canonicalName}:${item.unit}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, item);
      continue;
    }

    deduped.set(key, {
      ...existing,
      quantity: existing.quantity + item.quantity,
      confidence: Math.max(existing.confidence, item.confidence),
    });
  }

  return Array.from(deduped.values());
}
