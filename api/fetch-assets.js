import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

export default async function handler(req, res) {
  let { url } = req.query;

  if (!url) return res.status(400).json({ error: 'Missing URL parameter' });

  // Ensure the URL has a protocol
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(500).json({ error: `Failed to fetch website: ${response.status}` });
    }

    const html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Extract title
    const title = document.querySelector('title')?.textContent || null;

    // Extract favicon
    let favicon =
      document.querySelector('link[rel="icon"]')?.href ||
      document.querySelector('link[rel="shortcut icon"]')?.href ||
      null;

    // Resolve relative favicon URLs
    if (favicon && favicon.startsWith('/')) {
      const baseUrl = new URL(url).origin;
      favicon = baseUrl + favicon;
    }

    // Extract Open Graph image (often logo or main image)
    const ogImage = document.querySelector('meta[property="og:image"]')?.content || null;

    res.status(200).json({
      url,
      title,
      favicon,
      ogImage
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch or parse website' });
  }
}
