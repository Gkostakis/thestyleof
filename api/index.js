/**
 * Brand Identity Analyzer — Express Backend
 * Ethically scrapes public HTML/CSS to extract branding elements.
 * Respects robots.txt via User-Agent disclosure; no aggressive crawling.
 */

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const NodeCache = require('node-cache');
const path = require('path');
const url = require('url');

const app = express();
const cache = new NodeCache({ stdTTL: 300 }); // 5-minute cache per URL
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize a URL — add https:// if missing, validate structure.
 */
function normalizeUrl(inputUrl) {
  let u = inputUrl.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    return parsed.href;
  } catch {
    throw new Error('Invalid URL');
  }
}

/**
 * Resolve a potentially relative URL against a base.
 */
function resolveUrl(base, relative) {
  if (!relative) return null;
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL with browser-like headers to minimize blocking.
 * Timeout: 12s. Follows up to 5 redirects.
 */
async function fetchPage(targetUrl) {
  const response = await axios.get(targetUrl, {
    timeout: 12000,
    maxRedirects: 5,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; BrandAnalyzerBot/1.0; +https://github.com/brand-analyzer)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
    },
    responseType: 'text',
  });
  return response.data;
}

/**
 * Fetch a CSS file and return its text content.
 */
async function fetchCSS(cssUrl) {
  try {
    const response = await axios.get(cssUrl, {
      timeout: 8000,
      headers: { 'User-Agent': 'BrandAnalyzerBot/1.0' },
      responseType: 'text',
    });
    return response.data || '';
  } catch {
    return '';
  }
}

// ─── Extraction: Logo ──────────────────────────────────────────────────────

/**
 * Attempt to find the site logo via multiple heuristics (priority order):
 * 1. og:image (often the brand image)
 * 2. apple-touch-icon
 * 3. <img> elements whose src/alt/class/id contains "logo"
 * 4. favicon
 */
function extractLogo($, baseUrl) {
  const candidates = [];

  // 1. OG image
  const ogImg = $('meta[property="og:image"]').attr('content');
  if (ogImg) candidates.push({ url: resolveUrl(baseUrl, ogImg), source: 'og:image', priority: 1 });

  // 2. Twitter card image
  const twitterImg = $('meta[name="twitter:image"]').attr('content');
  if (twitterImg)
    candidates.push({
      url: resolveUrl(baseUrl, twitterImg),
      source: 'twitter:image',
      priority: 2,
    });

  // 3. Apple touch icon (high-res)
  $('link[rel="apple-touch-icon"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) candidates.push({ url: resolveUrl(baseUrl, href), source: 'apple-touch-icon', priority: 3 });
  });

  // 4. <img> elements with logo-related attributes
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    const alt = ($(el).attr('alt') || '').toLowerCase();
    const cls = ($(el).attr('class') || '').toLowerCase();
    const id = ($(el).attr('id') || '').toLowerCase();
    const isLogo =
      /logo/i.test(src) || /logo/.test(alt) || /logo/.test(cls) || /logo/.test(id);
    if (isLogo && src) {
      candidates.push({ url: resolveUrl(baseUrl, src), source: 'img[logo]', priority: 4 });
    }
  });

  // 5. SVG logo via <use> or inline
  $('svg').each((_, el) => {
    const cls = ($(el).attr('class') || '').toLowerCase();
    if (/logo/.test(cls)) candidates.push({ url: null, source: 'inline-svg', priority: 5 });
  });

  // 6. Favicon fallback
  const favicon =
    $('link[rel="icon"]').first().attr('href') ||
    $('link[rel="shortcut icon"]').first().attr('href');
  if (favicon)
    candidates.push({ url: resolveUrl(baseUrl, favicon), source: 'favicon', priority: 6 });

  // 7. Absolute fallback: /favicon.ico
  const parsed = new URL(baseUrl);
  candidates.push({ url: `${parsed.origin}/favicon.ico`, source: 'favicon-fallback', priority: 7 });

  // Return highest-priority candidate with a valid URL
  candidates.sort((a, b) => a.priority - b.priority);
  const best = candidates.find((c) => c.url);
  return best || null;
}

// ─── Extraction: Meta & Description ────────────────────────────────────────

function extractMeta($, targetUrl) {
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text().trim() ||
    '';

  const description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    '';

  const siteName =
    $('meta[property="og:site_name"]').attr('content') ||
    new URL(targetUrl).hostname.replace(/^www\./, '');

  return { title, description, siteName };
}

// ─── Extraction: Tagline / Slogan ──────────────────────────────────────────

function extractTagline($, description) {
  // OG description is often the tagline
  const og = $('meta[property="og:description"]').attr('content') || '';
  const twitter = $('meta[name="twitter:description"]').attr('content') || '';

  // Look for short hero text in h1/h2 or elements with "tagline/slogan/hero" classes
  const heroSelectors = [
    '[class*="tagline"]',
    '[class*="slogan"]',
    '[class*="hero"] h1',
    '[class*="hero"] h2',
    '[class*="headline"]',
    'header h1',
    'header h2',
    '.hero h1',
    '.hero h2',
    '#hero h1',
    '#hero h2',
  ];

  for (const sel of heroSelectors) {
    const text = $(sel).first().text().trim();
    if (text && text.length > 4 && text.length < 200) return text;
  }

  // Short og/twitter descriptions (< 120 chars) often ARE taglines
  if (og && og.length < 120) return og;
  if (twitter && twitter.length < 120) return twitter;

  // h1 fallback
  const h1 = $('h1').first().text().trim();
  if (h1 && h1.length < 150) return h1;

  return description.split('.')[0] || '';
}

// ─── Extraction: Fonts ─────────────────────────────────────────────────────

/**
 * Extract font families from CSS text.
 * Looks for @font-face, Google Fonts imports, and font-family declarations.
 */
function extractFontsFromCSS(cssText) {
  const fonts = new Set();

  // @font-face family names
  const fontFaceRegex = /@font-face\s*\{[^}]*font-family\s*:\s*['"]?([^;'"]+)['"]?/gi;
  let match;
  while ((match = fontFaceRegex.exec(cssText)) !== null) {
    fonts.add(match[1].trim().replace(/['"]/g, ''));
  }

  // font-family declarations in rules
  const fontFamilyRegex = /font-family\s*:\s*([^;}{]+)/gi;
  while ((match = fontFamilyRegex.exec(cssText)) !== null) {
    const families = match[1].split(',').map((f) => f.trim().replace(/['"]/g, ''));
    for (const f of families) {
      // Skip generic families
      if (!['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'inherit', 'initial', 'unset'].includes(f.toLowerCase())) {
        if (f.length > 1 && f.length < 60) fonts.add(f);
      }
    }
  }

  // CSS variables that reference fonts
  const varRegex = /--[\w-]*font[\w-]*\s*:\s*['"]?([A-Za-z][^;'"]+)['"]?/gi;
  while ((match = varRegex.exec(cssText)) !== null) {
    const val = match[1].trim().replace(/['"]/g, '');
    if (val.length > 1 && val.length < 60) fonts.add(val);
  }

  return [...fonts];
}

/**
 * Extract Google Fonts families from link tags.
 */
function extractGoogleFonts($) {
  const fonts = new Set();
  $('link[href*="fonts.googleapis.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    // family=Roboto:400,700|Open+Sans → ["Roboto", "Open Sans"]
    const familyParam = href.match(/family=([^&]+)/)?.[1];
    if (!familyParam) return;
    familyParam.split('|').forEach((entry) => {
      const name = entry.split(':')[0].replace(/\+/g, ' ').trim();
      if (name) fonts.add(name);
    });
  });
  // Also check @import in <style> tags
  $('style').each((_, el) => {
    const text = $(el).text();
    const importMatch = text.match(/fonts\.googleapis\.com\/css[^'"]+/g);
    if (importMatch) {
      importMatch.forEach((href) => {
        const fp = href.match(/family=([^&'"]+)/)?.[1];
        if (!fp) return;
        fp.split('|').forEach((entry) => {
          const n = entry.split(':')[0].replace(/\+/g, ' ').trim();
          if (n) fonts.add(n);
        });
      });
    }
  });
  return [...fonts];
}

async function extractFonts($, baseUrl) {
  const fonts = new Set();

  // Google Fonts from <link>
  extractGoogleFonts($).forEach((f) => fonts.add(f));

  // Inline <style> blocks
  $('style').each((_, el) => {
    extractFontsFromCSS($(el).text()).forEach((f) => fonts.add(f));
  });

  // External stylesheets (limit to 3 to keep response time reasonable)
  const cssUrls = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) cssUrls.push(resolveUrl(baseUrl, href));
  });

  const cssToFetch = cssUrls.filter(Boolean).slice(0, 3);
  await Promise.all(
    cssToFetch.map(async (cssUrl) => {
      const text = await fetchCSS(cssUrl);
      extractFontsFromCSS(text).forEach((f) => fonts.add(f));
    })
  );

  // Deduplicate and cap at 6
  const result = [...fonts].slice(0, 6);

  // Map fonts to categories (heading/body/mono)
  return result.map((name) => ({
    name,
    category: /mono|code|console|courier|fira|jetbrains|hack|source code/i.test(name)
      ? 'Monospace'
      : /serif(?!less)/i.test(name) || /garamond|georgia|times|playfair|merriweather|lora/i.test(name)
      ? 'Serif'
      : 'Sans-Serif',
    sample: 'Aa Bb Cc 123',
  }));
}

// ─── Extraction: Colors ────────────────────────────────────────────────────

/**
 * Extract color values from CSS text.
 * Targets CSS custom properties (--color-*), backgrounds, and frequent color rules.
 */
function extractColorsFromCSS(cssText) {
  const colorMap = new Map(); // hex → count

  // Named CSS variable colors first (most reliable for design systems)
  const varColorRegex = /--([\w-]*(?:color|bg|background|primary|secondary|accent|brand|text|foreground|surface|muted)[\w-]*)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsl[a]?\([^)]+\))/gi;
  let m;
  while ((m = varColorRegex.exec(cssText)) !== null) {
    const hex = normalizeColor(m[2]);
    if (hex && !isBlackOrWhite(hex)) colorMap.set(hex, (colorMap.get(hex) || 0) + 3);
  }

  // General color/background-color properties
  const colorPropRegex = /(?:^|[{;])\s*(?:background(?:-color)?|color|border-color|fill|stroke)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsl[a]?\([^)]+\))/gim;
  while ((m = colorPropRegex.exec(cssText)) !== null) {
    const hex = normalizeColor(m[1]);
    if (hex && !isBlackOrWhite(hex)) colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
  }

  return colorMap;
}

function isBlackOrWhite(hex) {
  if (!hex || hex.length < 6) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const brightness = (r + g + b) / 3;
  return brightness > 230 || brightness < 25;
}

/**
 * Convert color string to 6-digit hex. Returns null if unparseable.
 */
function normalizeColor(colorStr) {
  if (!colorStr) return null;
  colorStr = colorStr.trim();

  // Already hex
  if (/^#[0-9a-fA-F]{6}$/.test(colorStr)) return colorStr.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(colorStr)) {
    const r = colorStr[1];
    const g = colorStr[2];
    const b = colorStr[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{8}$/.test(colorStr)) return colorStr.slice(0, 7).toUpperCase();

  // rgb(r, g, b)
  const rgb = colorStr.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) {
    const r = parseInt(rgb[1]).toString(16).padStart(2, '0');
    const g = parseInt(rgb[2]).toString(16).padStart(2, '0');
    const b = parseInt(rgb[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`.toUpperCase();
  }

  // hsl(h, s%, l%)
  const hsl = colorStr.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/);
  if (hsl) {
    return hslToHex(parseFloat(hsl[1]), parseFloat(hsl[2]), parseFloat(hsl[3]));
  }

  return null;
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

/**
 * Compute luminance for accessibility labeling.
 */
function getLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

async function extractColors($, baseUrl) {
  const colorMap = new Map();

  // Parse inline <style> blocks
  $('style').each((_, el) => {
    const map = extractColorsFromCSS($(el).text());
    map.forEach((count, hex) => colorMap.set(hex, (colorMap.get(hex) || 0) + count));
  });

  // Parse up to 3 external CSS files
  const cssUrls = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) cssUrls.push(resolveUrl(baseUrl, href));
  });

  await Promise.all(
    cssUrls
      .filter(Boolean)
      .slice(0, 3)
      .map(async (cssUrl) => {
        const text = await fetchCSS(cssUrl);
        const map = extractColorsFromCSS(text);
        map.forEach((count, hex) => colorMap.set(hex, (colorMap.get(hex) || 0) + count));
      })
  );

  // Sort by frequency and take top 8
  const sorted = [...colorMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([hex, count]) => ({
      hex,
      rgb: hexToRgb(hex),
      luminance: getLuminance(hex),
      frequency: count,
      label: count > 5 ? 'Primary' : count > 2 ? 'Secondary' : 'Accent',
    }));

  // Relabel top 3 by frequency
  if (sorted[0]) sorted[0].label = 'Primary';
  if (sorted[1]) sorted[1].label = 'Secondary';
  if (sorted[2]) sorted[2].label = 'Accent';

  return sorted;
}

// ─── Main Analysis Route ────────────────────────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  const { url: rawUrl } = req.body;

  if (!rawUrl) return res.status(400).json({ error: 'URL is required' });

  let targetUrl;
  try {
    targetUrl = normalizeUrl(rawUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL — please include a valid domain.' });
  }

  // Check cache
  const cached = cache.get(targetUrl);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const html = await fetchPage(targetUrl);
    const $ = cheerio.load(html);

    // Run all extractions (colors + fonts require CSS fetches — parallelize)
    const [fonts, colors] = await Promise.all([
      extractFonts($, targetUrl),
      extractColors($, targetUrl),
    ]);

    const meta = extractMeta($, targetUrl);
    const logo = extractLogo($, targetUrl);
    const tagline = extractTagline($, meta.description);

    // Assemble result
    const result = {
      url: targetUrl,
      siteName: meta.siteName,
      title: meta.title,
      description: meta.description || 'No description found.',
      tagline: tagline || meta.description?.split('.')[0] || '',
      logo,
      fonts: fonts.length > 0 ? fonts : [{ name: 'System Default', category: 'Sans-Serif', sample: 'Aa Bb Cc 123' }],
      colors: colors.length > 0 ? colors : [],
      scrapedAt: new Date().toISOString(),
    };

    cache.set(targetUrl, result);
    res.json(result);
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 401) {
      return res.status(403).json({ error: 'Site blocked automated access (403/401). Try a different URL.' });
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return res.status(404).json({ error: 'Could not reach the website. Check the URL and try again.' });
    }
    if (err.code === 'ETIMEDOUT' || err.message?.includes('timeout')) {
      return res.status(408).json({ error: 'Request timed out. The site may be too slow or blocking bots.' });
    }
    console.error('[Analyze Error]', err.message);
    res.status(500).json({ error: 'Failed to analyze site. ' + (err.message || '') });
  }
});

// ─── Serve Frontend ─────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(const express = require("express");
const express = require('express');
const serverless = require('serverless-http');

const app = express();

app.get('/', (req, res) => {
  res.send('Hello from Express serverless!');
});

module.exports = serverless(app);

// api/index.js
export default function handler(req, res) {
  res.status(200).send('Hello from Vercel!');
}
