#!/usr/bin/env node
/*
  Berikar hits.json med 30-sekunders förhandslyssningar (previewUrl) + omslag (art)
  från iTunes Search API. Ingen inloggning och ingen nyckel behövs.

  Kör:  node tools/add-previews.mjs

  - Behåller dina fält (artist/title/year/url/id). Din `year` är fortfarande facit;
    iTunes-årtalet loggas bara när det skiljer sig (kan vara nyutgåva/samling).
  - Går att köra flera gånger: hoppar över rader som redan har previewUrl.
  - Skriver inget annat än hits.json, och bara fält som saknas.
*/
import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../hits.json', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookup(artist, title) {
  const term = encodeURIComponent((artist + ' ' + title).trim());
  const url = `https://itunes.apple.com/search?term=${term}&entity=song&limit=1&country=SE`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 403 || res.status === 429) { await sleep(4000); continue; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const t = (await res.json()).results[0];
    if (!t) return null;
    return {
      previewUrl: t.previewUrl || '',
      art: (t.artworkUrl100 || '').replace('100x100', '400x400'),
      year: (t.releaseDate || '').slice(0, 4),
    };
  }
  throw new Error('throttlad av iTunes');
}

const hits = JSON.parse(await readFile(FILE, 'utf8'));
let added = 0, skipped = 0, missed = 0, warned = 0;
console.log(`Berikar ${hits.length} rader från iTunes…\n`);
for (const h of hits) {
  if (h.previewUrl) { skipped++; continue; }
  let m = null;
  try {
    m = await lookup(h.artist, h.title);
  } catch (e) {
    console.log('  ! ' + h.artist + ' – ' + h.title + ': ' + e.message);
    missed++; await sleep(1200); continue;
  }
  if (m && m.previewUrl) {
    h.previewUrl = m.previewUrl;
    if (!h.art && m.art) h.art = m.art;
    added++;
    if (h.year && m.year && String(h.year) !== m.year) {
      warned++;
      console.log('  ⚠ ' + (h.artist + ' – ' + h.title).slice(0, 36).padEnd(38) + ' år: ditt ' + h.year + ' / iTunes ' + m.year);
    } else {
      console.log('  ✓ ' + (h.artist + ' – ' + h.title).slice(0, 44));
    }
  } else {
    missed++;
    console.log('  ✗ ingen träff: ' + h.artist + ' – ' + h.title);
  }
  await sleep(800);
}
await writeFile(FILE, JSON.stringify(hits, null, 2) + '\n', 'utf8');
console.log(`\nKlart: +${added} nya klipp, ${skipped} fanns redan, ${missed} utan träff, ${warned} med årtals-diff (din year gäller). Sparat hits.json.`);
