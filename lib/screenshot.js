// lib/screenshot.js - Maak screenshot van homepage met Puppeteer
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/data/screenshots';

function ensureDir() {
  try { if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); }
  catch (e) {
    const fallback = path.join(__dirname, '..', 'screenshots');
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
  return SCREENSHOT_DIR;
}

async function takeScreenshot(url, leadId) {
  if (!url) return null;
  const dir = ensureDir();
  const tempPath = path.join(dir, `${leadId}-temp.png`);
  const finalPath = path.join(dir, `${leadId}.jpg`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    // Korte wacht voor lazy-loaded elements
    await new Promise(r => setTimeout(r, 1500));

    await page.screenshot({ path: tempPath, fullPage: false });
    await browser.close();
    browser = null;

    // Comprimeer naar JPEG (kleiner, ~100KB)
    await sharp(tempPath)
      .resize(1280, 800, { fit: 'cover', position: 'top' })
      .jpeg({ quality: 75 })
      .toFile(finalPath);

    try { fs.unlinkSync(tempPath); } catch {}

    // Return relatief pad voor URL
    return `/screenshots/${leadId}.jpg`;
  } catch (err) {
    console.error(`Screenshot error voor ${url}:`, err.message);
    if (browser) try { await browser.close(); } catch {}
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    return null;
  }
}

function getScreenshotDir() {
  return ensureDir();
}

module.exports = { takeScreenshot, getScreenshotDir, SCREENSHOT_DIR };
