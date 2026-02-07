# Kitchen Knightmare

No-auth, mobile-first pantry app to reduce food waste by tracking ingredient expiration and recommending recipes that prioritize items expiring soon.

## What is implemented

- Pantry inventory CRUD (manual add, edit quantity/expiration override, remove)
- Receipt OCR extraction from uploaded image via OpenAI
- Receipt parsing pipeline (raw OCR text -> filtered line items -> canonical ingredient names)
- Shelf-life based expiration estimation using canonical ingredient mapping
- Expiration urgency ranking
- Recipe recommendation endpoint that returns strict JSON (3-5 recipes)
- OpenAI integration (optional fallback for recipes when key is missing)
- Browser notifications for items nearing expiration (when permission granted)
- Offline pantry caching via `localStorage`

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment

Copy `.env.example` to `.env.local`.

```bash
OPENAI_API_KEY=your_key_here
# Optional for recipes
OPENAI_MODEL=gpt-4o-mini
# Optional for OCR (defaults to OPENAI_MODEL, then gpt-4o-mini)
OPENAI_OCR_MODEL=gpt-4o-mini
```

Notes:
- If `OPENAI_API_KEY` is not set, `/api/recipes` falls back to deterministic templates.
- OCR endpoint requires `OPENAI_API_KEY`.

## Main routes

- `/` pantry + recipe recommendations
- `/scan` receipt image preview + OCR extraction + text parsing + pantry import
- `/api/receipts/ocr` extract OCR text from receipt image (OpenAI)
- `/api/receipts/parse` parse receipt raw text into canonical pantry items
- `/api/recipes` generate structured recipe suggestions

## Build checks run

- `npm run lint` passed
- `npm run build` passed
