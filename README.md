# Kitchen Knightmare

Pantry app to reduce food waste by tracking ingredient expiration and recommending recipes that prioritize items expiring soon.

## What is implemented

- Pantry inventory CRUD (manual add, edit quantity/expiration override, remove)
- Receipt OCR extraction from uploaded image
- Receipt parsing pipeline
- Shelf-life based expiration estimation using canonical ingredient mapping
- Expiration urgency ranking
- Recipe recommendation (3-5 recipes)

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.


## Main routes

- `/` pantry + recipe recommendations
- `/scan` receipt image preview + OCR extraction + text parsing + pantry import
- `/api/receipts/ocr` extract OCR text from receipt image (OpenAI)
- `/api/receipts/parse` parse receipt raw text into canonical pantry items
- `/api/recipes` generate structured recipe suggestions