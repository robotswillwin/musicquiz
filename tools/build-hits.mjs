#!/usr/bin/env node
/* ============================================================
   build-hits.mjs — DEV-ONLY (kor1s aldrig i produkten).

   Tva0 jobb, oberoende av varandra:
     1) ARSKONTROLL via MusicBrainz (oppet API, ingen inloggning).
        Korskollar vart curated-artal mot MusicBrainz forsta-utgivningsar.
        Detta ar facit-kontrollen - Spotifys datum duger inte (remasters).
     2) SPOTIFY-LANKAR (kraver token) - fyller url/id/art med riktiga spar.

   Kor arskontroll utan token:
        node tools/build-hits.mjs
   Kor BADE arskontroll och fyll i Spotify-lankar:
        SPOTIFY_CLIENT_SECRET=xxxx node tools/build-hits.mjs
        (eller SPOTIFY_TOKEN=yyyy for en fardig access-token)
   Flaggor:
        SKIP_MB=1     hoppa over arskontrollen (bara Spotify-lankar)
        ONLY=NN       kor bara de NN forsta latarna (for snabb test)

   Secret/token lases bara fran env och skrivs ALDRIG till nagon fil.
   Vart year-falt andras ALDRIG av scriptet - det flaggar bara avvikelser.
   ============================================================ */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HITS = path.join(HERE, '..', 'hits.json');
const DEFAULT_CLIENT_ID = '4790763952374a648ad20b755f3b9154';
const MB_UA = 'BitsterHitsBuilder/1.0 (musikquiz dev tool)';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = x => String(x || '').toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const yearOf = d => parseInt(String(d || '').slice(0, 4), 10) || 0;
const label = (k, s) => (k + 1) + '. ' + s.artist + ' - ' + s.title;

/* ---------- Spotify (valfritt) ---------- */
async function getToken() {
  if (process.env.SPOTIFY_TOKEN) return process.env.SPOTIFY_TOKEN.trim();
  const secret = (process.env.SPOTIFY_CLIENT_SECRET || '').trim();
  if (!secret) return null;                       // ingen token -> hoppa over lankar
  const id = (process.env.SPOTIFY_CLIENT_ID || DEFAULT_CLIENT_ID).trim();
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) { console.error('Spotify-token misslyckades (' + res.status + '): ' + (data.error_description || data.error || '?')); process.exit(2); }
  return data.access_token;
}

function spPickBest(items, artist, title) {
  const na = norm(artist), nt = norm(title);
  let best = null, bestScore = -1;
  for (const t of items) {
    if (!t || !t.id) continue;
    const tn = norm(t.name);
    const arts = (t.artists || []).map(a => norm(a.name));
    let score = 0;
    if (arts.some(a => a && (a === na || a.includes(na) || na.includes(a)))) score += 3;
    if (tn === nt) score += 3; else if (tn.includes(nt) || nt.includes(tn)) score += 1;
    if (/karaoke|tribute|made famous|originally performed|cover version|8-?bit|lullaby|instrumental/.test((t.name || '').toLowerCase())) score -= 5;
    score += (t.popularity || 0) / 1000;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (!best || bestScore < 3) return null;
  const imgs = (best.album && best.album.images) || [];
  return {
    id: best.id,
    url: (best.external_urls && best.external_urls.spotify) || ('https://open.spotify.com/track/' + best.id),
    art: (imgs[0] && imgs[0].url) || '',
    spotifyYear: yearOf(best.album && best.album.release_date),
  };
}

async function spSearch(token, artist, title) {
  const headers = { Authorization: 'Bearer ' + token };
  const queries = ['track:"' + title + '" artist:"' + artist + '"', artist + ' ' + title];
  for (const q of queries) {
    const url = 'https://api.spotify.com/v1/search?type=track&limit=10&market=SE&q=' + encodeURIComponent(q);
    let res = await fetch(url, { headers });
    if (res.status === 429) { await sleep((parseInt(res.headers.get('retry-after') || '2', 10) + 1) * 1000); res = await fetch(url, { headers }); }
    if (res.status === 401) throw new Error('401 token ogiltig');
    if (!res.ok) continue;
    const best = spPickBest(((await res.json()).tracks || {}).items || [], artist, title);
    if (best) return best;
  }
  return null;
}

/* ---------- MusicBrainz (arskontroll, ingen inloggning) ---------- */
const mbEsc = s => String(s || '').replace(/[+\-!(){}\[\]^"~*?:\\/]/g, ' ').trim();

async function mbYear(artist, title) {
  const q = 'recording:"' + mbEsc(title) + '" AND artist:"' + mbEsc(artist) + '"';
  const url = 'https://musicbrainz.org/ws/2/recording?fmt=json&limit=100&query=' + encodeURIComponent(q);
  let res = null;
  for (let i = 0; i < 4; i++) {                       // taligt for natverksblippar / 503 / 429
    try {
      res = await fetch(url, { headers: { 'User-Agent': MB_UA } });
      if (res.status === 503 || res.status === 429) { await sleep(2000 + i * 1000); res = null; continue; }
      break;
    } catch (e) { res = null; if (i === 3) return null; await sleep(1500 * (i + 1)); }
  }
  if (!res || !res.ok) return null;
  let recs;
  try { recs = ((await res.json()).recordings) || []; } catch (e) { return null; }
  const na = norm(artist), nt = norm(title);
  const years = [];
  for (const r of recs) {
    const rt = norm(r.title);
    const ac = (r['artist-credit'] || []).map(a => norm(a.name || (a.artist && a.artist.name))).join('');
    const artistOk = ac && (ac.includes(na) || na.includes(ac));
    const titleOk = rt === nt || rt.includes(nt) || nt.includes(rt);
    const y = yearOf(r['first-release-date']);
    if (artistOk && titleOk && y > 1900) years.push(y);
  }
  if (!years.length) return null;
  return { year: Math.min(...years), n: years.length };
}

/* ---------- main ---------- */
async function main() {
  const token = await getToken();
  const doMB = process.env.SKIP_MB !== '1';
  const limit = process.env.ONLY ? parseInt(process.env.ONLY, 10) : Infinity;
  const songs = JSON.parse(fs.readFileSync(HITS, 'utf8'));

  console.log('\n  Spotify-lankar: ' + (token ? 'JA' : 'nej (ingen token)') + '   |   MusicBrainz-arskontroll: ' + (doMB ? 'JA' : 'nej') + '   |   ' + songs.length + ' latar\n');

  const reviewYear = [];   // vart ar != MB med >1
  const noMB = [];         // ingen MB-data (overifierat ar)
  const noLink = [];       // Spotify-lank saknas
  let verified = 0, links = 0;

  for (let k = 0; k < songs.length && k < limit; k++) {
    const s = songs[k];

    if (token) {
      let m = null; try { m = await spSearch(token, s.artist, s.title); } catch (e) {}
      if (m) { s.url = m.url; s.id = m.id; s.art = m.art; links++; }
      else { s.url = s.url || ''; s.id = s.id || ''; s.art = s.art || ''; noLink.push(label(k, s)); }
    }

    let yTag = '';
    if (doMB) {
      let mb = null; try { mb = await mbYear(s.artist, s.title); } catch (e) {}
      if (!mb) { yTag = '. MB saknas'; noMB.push(label(k, s)); }
      else {
        const diff = Math.abs(mb.year - s.year);
        if (diff === 0) { yTag = 'OK ' + mb.year; verified++; }
        else if (diff === 1) { yTag = '~ ' + mb.year + ' (+-1)'; verified++; }
        else { yTag = 'FLAG MB ' + mb.year + ' vs ' + s.year; reviewYear.push(label(k, s) + '  -> vart ' + s.year + ', MusicBrainz ' + mb.year); }
      }
      await sleep(1100);   // MusicBrainz: max 1 anrop/sekund
    }

    console.log('  ' + String(k + 1).padStart(3) + '  ' + String(s.year) + '  ' + (s.artist + ' - ' + s.title).slice(0, 46).padEnd(46) + '  ' + (token ? (s.url ? 'link+' : 'link-') : '     ') + '  ' + yTag);
  }

  fs.writeFileSync(HITS, JSON.stringify(songs, null, 2) + '\n');
  const n = Math.min(songs.length, limit);
  console.log('\n  -- sammanfattning ---------------------------------');
  if (doMB) console.log('  Arskontroll: ' + verified + '/' + n + ' stammer med MusicBrainz (+-1).  ' + reviewYear.length + ' avviker, ' + noMB.length + ' utan MB-data.');
  if (token) console.log('  Spotify-lankar: ' + links + '/' + n + ' fyllda, ' + noLink.length + ' saknas.');
  if (reviewYear.length) { console.log('\n  GRANSKA AR (vart != MusicBrainz):'); for (const f of reviewYear) console.log('   - ' + f); }
  if (noMB.length) { console.log('\n  Utan MusicBrainz-data (ar overifierat):'); for (const f of noMB) console.log('   - ' + f); }
  if (token && noLink.length) { console.log('\n  Saknar Spotify-lank:'); for (const f of noLink) console.log('   - ' + f); }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
