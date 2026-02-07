'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChangeEvent, useEffect, useState } from 'react';
import { PARSED_RECEIPT_STORAGE_KEY } from '@/lib/constants';
import { createInventoryItem, loadPantryFromStorage, savePantryToStorage } from '@/lib/pantry';
import { canonicalizeIngredient } from '@/lib/shelfLife';
import type { ParsedReceiptItem } from '@/lib/types';

type ParseResponse = {
  items?: ParsedReceiptItem[];
  error?: string;
};

type OcrResponse = {
  rawText?: string;
  groceryLines?: string[];
  items?: ParsedReceiptItem[];
  error?: string;
};

type EditableReceiptItem = ParsedReceiptItem & {
  localId: string;
};

function withLocalIds(items: ParsedReceiptItem[]): EditableReceiptItem[] {
  return items.map((item) => ({ ...item, localId: crypto.randomUUID() }));
}

export default function ScanPage() {
  const router = useRouter();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsedItems, setParsedItems] = useState<EditableReceiptItem[]>([]);
  const [isExtractingOcr, setIsExtractingOcr] = useState(false);
  const [hasCompletedOcr, setHasCompletedOcr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [manualName, setManualName] = useState('');
  const [manualQuantity, setManualQuantity] = useState('1');
  const [manualUnit, setManualUnit] = useState('item');

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      setImageUrl(null);
      setSelectedFile(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setSelectedFile(file);
  }

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  useEffect(() => {
    const cached = window.localStorage.getItem(PARSED_RECEIPT_STORAGE_KEY);
    if (!cached) return;

    try {
      const parsed = JSON.parse(cached) as ParsedReceiptItem[];
      if (Array.isArray(parsed)) {
        setParsedItems(withLocalIds(parsed));
        if (parsed.length > 0) {
          setHasCompletedOcr(true);
        }
      }
    } catch {
      window.localStorage.removeItem(PARSED_RECEIPT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    const serializableItems: ParsedReceiptItem[] = parsedItems.map((item) => ({
      rawLine: item.rawLine,
      canonicalName: item.canonicalName,
      displayName: item.displayName,
      quantity: item.quantity,
      unit: item.unit,
      confidence: item.confidence,
    }));
    if (serializableItems.length === 0) {
      window.localStorage.removeItem(PARSED_RECEIPT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PARSED_RECEIPT_STORAGE_KEY, JSON.stringify(serializableItems));
  }, [parsedItems]);

  async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
          return;
        }
        reject(new Error('Could not read receipt image.'));
      };
      reader.onerror = () => reject(new Error('Could not read receipt image.'));
      reader.readAsDataURL(file);
    });
  }

  async function parseReceiptFromText(text: string) {
    if (!text.trim()) {
      setError('Paste OCR text first.');
      return;
    }

    try {
      const response = await fetch('/api/receipts/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: text }),
      });

      const payload = (await response.json()) as ParseResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? 'Receipt parsing failed.');
      }

      const nextItems = payload.items ?? [];
      setParsedItems(withLocalIds(nextItems));
      window.localStorage.setItem(PARSED_RECEIPT_STORAGE_KEY, JSON.stringify(nextItems));
      setError(null);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Could not parse receipt text.');
    }
  }

  async function extractOcrText() {
    if (!selectedFile) {
      setError('Select a receipt image first.');
      return;
    }

    setIsExtractingOcr(true);
    setError(null);

    try {
      const imageDataUrl = await fileToDataUrl(selectedFile);

      const response = await fetch('/api/receipts/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl }),
      });

      const payload = (await response.json()) as OcrResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? 'OCR extraction failed.');
      }

      if (Array.isArray(payload.items) && payload.items.length > 0) {
        setParsedItems(withLocalIds(payload.items));
        window.localStorage.setItem(PARSED_RECEIPT_STORAGE_KEY, JSON.stringify(payload.items));
        setError(null);
        return;
      }

      const nextRawText =
        payload.rawText?.trim() ??
        (Array.isArray(payload.groceryLines) ? payload.groceryLines.join('\n').trim() : '');

      if (!nextRawText) {
        throw new Error('OCR returned no grocery line items.');
      }

      await parseReceiptFromText(nextRawText);
    } catch (ocrError) {
      setError(ocrError instanceof Error ? ocrError.message : 'Could not extract OCR text.');
    } finally {
      setIsExtractingOcr(false);
      setHasCompletedOcr(true);
    }
  }

  function updateParsedItem(localId: string, patch: Partial<EditableReceiptItem>) {
    setParsedItems((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    );
  }

  function removeParsedItem(localId: string) {
    setParsedItems((prev) => prev.filter((item) => item.localId !== localId));
  }

  function addManualItem() {
    const name = manualName.trim();
    const quantity = Number(manualQuantity);
    const unit = manualUnit.trim() || 'item';

    if (!name) {
      setError('Manual item name is required.');
      return;
    }

    if (Number.isNaN(quantity) || quantity <= 0) {
      setError('Manual item quantity must be a positive number.');
      return;
    }

    const { canonicalName } = canonicalizeIngredient(name);
    const newItem: EditableReceiptItem = {
      localId: crypto.randomUUID(),
      rawLine: `${name} ${quantity} ${unit}`,
      canonicalName,
      displayName: name,
      quantity,
      unit,
      confidence: 1,
    };

    setParsedItems((prev) => [newItem, ...prev]);
    setManualName('');
    setManualQuantity('1');
    setManualUnit('item');
    setError(null);
  }

  function importToPantry() {
    const validatedItems = parsedItems.filter(
      (item) => item.displayName.trim().length > 0 && Number.isFinite(item.quantity) && item.quantity > 0,
    );

    if (validatedItems.length === 0) {
      setError('No valid items to import. Ensure each item has a name and positive quantity.');
      return;
    }

    try {
      const existing = loadPantryFromStorage();
      const imported = validatedItems.map((item) =>
        createInventoryItem({
          name: item.displayName,
          quantity: item.quantity,
          unit: item.unit || 'item',
          source: 'receipt',
        }),
      );

      savePantryToStorage([...imported, ...existing]);
      window.localStorage.removeItem(PARSED_RECEIPT_STORAGE_KEY);
      setImportedCount(imported.length);
      setError(null);
      router.push('/');
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Failed to import pantry items.');
    }
  }

  return (
    <main className="shell">
      <section className="hero compact">
        <p className="eyebrow">Receipt Scanner</p>
        <h1>Upload receipt and validate parsed food items.</h1>
        <p>
          OCR extraction auto-parses into editable food items. Review, modify, and import only what
          you want in your pantry.
        </p>
        <Link href="/" className="ghostButton">
          Back to pantry
        </Link>
      </section>

      <section className="panel">
        <label htmlFor="receipt" className="primaryButton uploadButton">
          Select image
        </label>
        <input
          id="receipt"
          type="file"
          accept="image/*"
          className="hiddenInput"
          onChange={handleFileChange}
        />

        {imageUrl ? (
          <div className="previewWrapper">
            <Image
              src={imageUrl}
              alt="Receipt preview"
              width={1200}
              height={1600}
              className="previewImage"
              unoptimized
            />
          </div>
        ) : (
          <p className="muted">No receipt image selected.</p>
        )}

        <label>
          Parsed grocery items
          <p className="muted">
            OCR results are shown below for validation. Add any missed item before importing.
          </p>
        </label>

        <div className="rowButtons">
          <button
            type="button"
            className="primaryButton"
            onClick={extractOcrText}
            disabled={isExtractingOcr}
          >
            {isExtractingOcr ? 'Extracting OCR...' : 'Extract OCR + auto-parse'}
          </button>
          <button type="button" className="primaryButton" onClick={importToPantry}>
            Import validated items
          </button>
        </div>

        {hasCompletedOcr ? (
          <div className="receiptItemEditor">
            <label>
              Add missed item
              <input value={manualName} onChange={(event) => setManualName(event.target.value)} />
            </label>
            <label>
              Quantity
              <input
                type="number"
                min="0"
                step="0.01"
                value={manualQuantity}
                onChange={(event) => setManualQuantity(event.target.value)}
              />
            </label>
            <label>
              Unit
              <input value={manualUnit} onChange={(event) => setManualUnit(event.target.value)} />
            </label>
            <button type="button" className="primaryButton" onClick={addManualItem}>
              Add item
            </button>
          </div>
        ) : null}

        {parsedItems.length > 0 ? (
          <ul className="ingredientList">
            {parsedItems.map((item) => (
              <li key={item.localId} className="ingredientCard">
                <div className="receiptItemEditor">
                  <label>
                    Item
                    <input
                      value={item.displayName}
                      onChange={(event) =>
                        updateParsedItem(item.localId, { displayName: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Quantity
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.quantity}
                      onChange={(event) =>
                        updateParsedItem(item.localId, { quantity: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Unit
                    <input
                      value={item.unit}
                      onChange={(event) => updateParsedItem(item.localId, { unit: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className="dangerButton"
                    onClick={() => removeParsedItem(item.localId)}
                  >
                    Remove
                  </button>
                </div>
                <p className="muted">
                  Parsed as {item.canonicalName} · confidence {(item.confidence * 100).toFixed(0)}%
                </p>
              </li>
            ))}
          </ul>
        ) : null}

        {importedCount > 0 ? <p className="muted">Imported {importedCount} items to pantry.</p> : null}
      </section>

      {error ? <p className="errorText">{error}</p> : null}
    </main>
  );
}
