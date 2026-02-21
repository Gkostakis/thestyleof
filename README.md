# Brand×Extract — Visual Identity Analyzer

Extract logos, fonts, colors, taglines, and descriptions from any public website.

## Stack

- **Backend**: Node.js + Express (scraping via Axios + Cheerio)
- **Frontend**: Vanilla JS + CSS (custom editorial design, no framework)
- **Exports**: JSON + PDF (jsPDF)

## Local Setup

```bash
# 1. Install dependencies
npm install

# 2. Run the server
npm start
# → http://localhost:3000

# Dev mode (auto-restart)
npm run dev
```

## Deploy to Vercel (one command)

```bash
# Install Vercel CLI if needed
npm i -g vercel

# Deploy
vercel
```

## Deploy to Railway / Render

Push to GitHub, then connect repo. Set:
- **Build command**: `npm install`
- **Start command**: `npm start`
- **Port**: `3000` (auto-detected via `PORT` env var)

## What It Extracts

| Field        | Method                                                              |
|--------------|---------------------------------------------------------------------|
| **Logo**     | og:image → apple-touch-icon → img[class*=logo] → favicon          |
| **Tagline**  | og:description (short) → hero h1/h2 → [class*=tagline]            |
| **Fonts**    | Google Fonts links → @font-face CSS → font-family declarations     |
| **Colors**   | CSS custom properties → background-color → color rules (top 6)    |
| **Description** | meta[name=description] → og:description → twitter:description  |

## Ethical Scraping Notes

- Identifies itself via `User-Agent: BrandAnalyzerBot/1.0`
- Single-page fetch only — no crawling
- 5-minute server-side cache prevents repeat hits
- 12s timeout prevents hanging
- Does not bypass authentication or paywalls

## Limitations

- Sites that block bots (Cloudflare CAPTCHA, etc.) will return 403
- JavaScript-rendered content (React SPAs) may have limited CSS extraction
- Logo detection is heuristic — SVG inline logos won't render in the img tag
