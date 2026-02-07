'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { PARSED_RECEIPT_STORAGE_KEY } from '@/lib/constants';
import { createInventoryItem, loadPantryFromStorage, savePantryToStorage } from '@/lib/pantry';
import { canonicalizeIngredient } from '@/lib/shelfLife';
import type { ParsedReceiptItem } from '@/lib/types';

type ParseResponse = {
  items?: ParsedReceiptItem[];
  error?: string;
};

type OcrResponse = {
  purchaseDate?: string;
  rawText?: string;
  groceryLines?: string[];
  items?: ParsedReceiptItem[];
  error?: string;
};

type ShelfLifeResponse = {
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

type EditableReceiptItem = ParsedReceiptItem & {
  localId: string;
};

function withLocalIds(items: ParsedReceiptItem[]): EditableReceiptItem[] {
  return items.map((item) => ({ ...item, localId: crypto.randomUUID() }));
}

export default function ScanPage() {
  const router = useRouter();
  const fallbackCameraInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsedItems, setParsedItems] = useState<EditableReceiptItem[]>([]);
  const [isExtractingOcr, setIsExtractingOcr] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [hasCompletedOcr, setHasCompletedOcr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [receiptPurchaseDate, setReceiptPurchaseDate] = useState<string | null>(null);
  const [manualName, setManualName] = useState('');
  const [manualQuantity, setManualQuantity] = useState('1');
  const [manualUnit, setManualUnit] = useState('item');
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);

  function stopCamera(updateState = true) {
    if (cameraStreamRef.current) {
      for (const track of cameraStreamRef.current.getTracks()) {
        track.stop();
      }
      cameraStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (updateState) {
      setIsCameraOpen(false);
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      fallbackCameraInputRef.current?.click();
      return;
    }

    try {
      setIsStartingCamera(true);
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });

      cameraStreamRef.current = stream;
      setIsCameraOpen(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch {
      setError('Could not access camera. Check browser permission and device camera settings.');
      fallbackCameraInputRef.current?.click();
    } finally {
      setIsStartingCamera(false);
    }
  }

  async function captureFromCamera() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setError('Camera is not ready yet. Try again in a moment.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      setError('Could not capture image from camera.');
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92),
    );
    if (!blob) {
      setError('Could not capture image from camera.');
      return;
    }

    const file = new File([blob], `receipt-${Date.now()}.jpg`, { type: 'image/jpeg' });
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setSelectedFile(file);
    setReceiptPurchaseDate(null);
    setHasCompletedOcr(false);
    stopCamera();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    stopCamera();
    const file = event.target.files?.[0];
    if (!file) {
      setImageUrl(null);
      setSelectedFile(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setSelectedFile(file);
    setReceiptPurchaseDate(null);
  }

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  useEffect(() => {
    return () => {
      stopCamera(false);
    };
  }, []);

  useEffect(() => {
    const cached = window.localStorage.getItem(PARSED_RECEIPT_STORAGE_KEY);
    if (!cached) return;

    try {
      const parsed = JSON.parse(cached) as ParsedReceiptItem[];
      if (Array.isArray(parsed)) {
        setParsedItems(withLocalIds(parsed));
        const purchaseDate = parsed.find((item) => item.purchaseDate)?.purchaseDate;
        setReceiptPurchaseDate(purchaseDate ?? null);
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
      purchaseDate: item.purchaseDate,
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
      console.info('[client] request', {
        endpoint: '/api/receipts/parse',
        rawTextLength: text.trim().length,
      });
      const response = await fetch('/api/receipts/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: text }),
      });
      console.info('[client] response', {
        endpoint: '/api/receipts/parse',
        status: response.status,
        ok: response.ok,
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
      console.info('[client] request', {
        endpoint: '/api/receipts/ocr',
        hasImageDataUrl: Boolean(imageDataUrl),
      });

      const response = await fetch('/api/receipts/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl }),
      });
      console.info('[client] response', {
        endpoint: '/api/receipts/ocr',
        status: response.status,
        ok: response.ok,
      });

      const payload = (await response.json()) as OcrResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? 'OCR extraction failed.');
      }
      setReceiptPurchaseDate(payload.purchaseDate ?? null);

      if (Array.isArray(payload.items) && payload.items.length > 0) {
        const normalizedItems = payload.items.map((item) => ({
          ...item,
          purchaseDate: item.purchaseDate ?? payload.purchaseDate,
        }));
        setParsedItems(withLocalIds(normalizedItems));
        window.localStorage.setItem(PARSED_RECEIPT_STORAGE_KEY, JSON.stringify(normalizedItems));
        setReceiptPurchaseDate(payload.purchaseDate ?? null);
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
      purchaseDate: receiptPurchaseDate ?? undefined,
    };

    setParsedItems((prev) => [newItem, ...prev]);
    setManualName('');
    setManualQuantity('1');
    setManualUnit('item');
    setError(null);
  }

  async function importToPantry() {
    const validatedItems = parsedItems.filter(
      (item) => item.displayName.trim().length > 0 && Number.isFinite(item.quantity) && item.quantity > 0,
    );

    if (validatedItems.length === 0) {
      setError('No valid items to import. Ensure each item has a name and positive quantity.');
      return;
    }

    try {
      setIsImporting(true);
      const existing = loadPantryFromStorage();
      console.info('[client] request', {
        endpoint: '/api/shelf-life',
        items: validatedItems.length,
      });
      const shelfLifeResponse = await fetch('/api/shelf-life', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: validatedItems.map((item) => ({
            name: item.displayName,
            canonicalName: item.canonicalName,
          })),
        }),
      });
      console.info('[client] response', {
        endpoint: '/api/shelf-life',
        status: shelfLifeResponse.status,
        ok: shelfLifeResponse.ok,
      });

      const shelfLifePayload = (await shelfLifeResponse.json()) as ShelfLifeResponse;
      console.info('[client] shelf-life payload', {
        provider: shelfLifePayload.provider,
        warning: shelfLifePayload.warning,
        debug: shelfLifePayload.debug,
      });
      const shelfLifeByCanonical = shelfLifePayload.shelfLifeByCanonical ?? {};
      if (!shelfLifeResponse.ok) {
        throw new Error(shelfLifePayload.error ?? 'Failed to retrieve shelf-life data.');
      }

      const imported = validatedItems.map((item) =>
        createInventoryItem({
          name: item.displayName,
          quantity: item.quantity,
          unit: item.unit || 'item',
          purchaseDate: item.purchaseDate ?? receiptPurchaseDate ?? undefined,
          shelfLifeDaysOverride: shelfLifeByCanonical[item.canonicalName],
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
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero compact">
        <p className="eyebrow">Receipt Scanner</p>
        <h1>Upload receipt and validate parsed food items.</h1>
        <p>
          Scan your grocery receipt to update your inventory. Review, modify, and import only what
          you want in your pantry.
        </p>
        <Link href="/" className="ghostButton">
          Back to pantry
        </Link>
      </section>

      <section className="panel">
        <div className="rowButtons">
          <label htmlFor="receipt-upload" className="primaryButton uploadButton">
            Upload receipt
          </label>
          <button
            type="button"
            className="primaryButton uploadButton"
            onClick={() => void startCamera()}
            disabled={isStartingCamera}
          >
            {isStartingCamera ? 'Opening camera...' : 'Use camera'}
          </button>
        </div>
        <input
          id="receipt-upload"
          type="file"
          accept="image/*"
          className="hiddenInput"
          onChange={handleFileChange}
        />
        <input
          ref={fallbackCameraInputRef}
          id="receipt-camera-fallback"
          type="file"
          accept="image/*"
          capture="environment"
          className="hiddenInput"
          onChange={handleFileChange}
        />

        {isCameraOpen ? (
          <div className="previewWrapper">
            <video ref={videoRef} className="previewImage" playsInline muted />
            <div className="rowButtons">
              <button type="button" className="primaryButton" onClick={() => void captureFromCamera()}>
                Capture photo
              </button>
              <button type="button" className="ghostButton" onClick={stopCamera}>
                Cancel camera
              </button>
            </div>
          </div>
        ) : null}

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
        {receiptPurchaseDate ? (
          <p className="muted">
            Detected purchase date: {new Date(receiptPurchaseDate).toLocaleDateString('en-US')}
          </p>
        ) : null}

        <div className="rowButtons">
          <button
            type="button"
            className="primaryButton"
            onClick={extractOcrText}
            disabled={isExtractingOcr}
          >
            {isExtractingOcr ? 'Scanning...' : 'Scan receipt'}
          </button>
          <button
            type="button"
            className="primaryButton"
            onClick={() => void importToPantry()}
            disabled={isImporting}
          >
            {isImporting ? 'Importing...' : 'Import validated items'}
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
