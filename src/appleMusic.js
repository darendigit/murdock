/**
 * Apple Music resolver.
 *
 * Apple Music streams are DRM-protected (FairPlay) and cannot be downloaded —
 * same as Spotify. So we read the track's public metadata and match it against
 * YouTube, then download that. No API key: the song page carries schema.org
 * JSON-LD (a MusicRecording with name + byArtist) plus OpenGraph tags, both
 * scrapable without auth. JSON-LD is preferred; OpenGraph is the fallback.
 *
 * Mirrors src/spotify.js — same return shape so the server can treat both the
 * same way.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function metaContent(html, property) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
    'i'
  );
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
    'i'
  );
  const match = html.match(pattern) || html.match(alt);
  return match ? decodeEntities(match[1]).trim() : null;
}

async function fetchWithTimeout(url, ms = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recursively find a schema.org MusicRecording (or MusicVideo) node anywhere in
 * the JSON-LD tree — Apple Music nests it (the top node is often a
 * MusicComposition, with the recording under a property), so we must descend
 * into every value, not just @graph.
 */
function findMusicRecording(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findMusicRecording(item);
      if (found) return found;
    }
    return null;
  }
  const type = node['@type'];
  const isRecording = Array.isArray(type)
    ? type.some((t) => /MusicRecording|MusicVideo|Song/i.test(t))
    : /MusicRecording|MusicVideo|Song/i.test(type || '');
  if (isRecording && (node.name || node.byArtist)) return node;
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findMusicRecording(value);
      if (found) return found;
    }
  }
  return null;
}

/** "PT4M48S" → 288. */
function parseIso8601Duration(iso) {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!m) return null;
  const [, h, min, s] = m.map((v) => (v ? Number(v) : 0));
  const total = h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}

/**
 * Turn an Apple Music song URL into a YouTube search term plus display metadata.
 * Returns { searchQuery, title, artist, thumbnail, durationSeconds }.
 */
export async function resolveAppleMusic(rawUrl) {
  // A single song is either an album URL with ?i=<id> or a /song/ URL. Anything
  // else (album, artist, playlist) has no single track to match.
  const isSong = /[?&]i=\d+/.test(rawUrl) || /\/song\//.test(rawUrl);
  if (!isSong) {
    throw new Error(
      'Paste a link to a single Apple Music song (the URL includes "?i=…"), not an album or playlist.'
    );
  }

  const res = await fetchWithTimeout(rawUrl);
  if (!res.ok) {
    throw new Error(
      `Apple Music returned ${res.status} for that link. It may be region-locked or removed.`
    );
  }
  const html = await res.text();

  let title = null;
  let artist = null;
  let thumbnail = null;
  let durationSeconds = null;

  // 1. schema.org JSON-LD — the reliable path.
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const block of blocks) {
    let data;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const rec = findMusicRecording(data);
    if (rec) {
      title = rec.name ? decodeEntities(String(rec.name)).trim() : title;
      const artists = (Array.isArray(rec.byArtist) ? rec.byArtist : [rec.byArtist])
        .filter(Boolean)
        .map((a) => (typeof a === 'string' ? a : a.name))
        .filter(Boolean)
        .map((n) => decodeEntities(String(n)).trim());
      if (artists.length) artist = artists.join(' ');
      if (rec.duration) durationSeconds = parseIso8601Duration(rec.duration);
      break;
    }
  }

  // 2. OpenGraph fallback: og:title is "<title> by <artist> on Apple Music".
  if (!title || !artist) {
    const ogTitle = metaContent(html, 'og:title');
    if (ogTitle) {
      const m = ogTitle.match(/^(.*?)\s+by\s+(.*?)\s+on Apple Music$/i);
      if (m) {
        title = title || m[1].trim();
        artist = artist || m[2].trim();
      } else {
        title = title || ogTitle.replace(/\s+on Apple Music\s*$/i, '').trim();
      }
    }
  }

  thumbnail = thumbnail || metaContent(html, 'og:image');

  // Duration fallback from og:description ("Song · 1985 · Duration 4:48").
  if (durationSeconds == null) {
    const desc = metaContent(html, 'og:description') || '';
    const d = desc.match(/Duration\s+(?:(\d+):)?(\d+):(\d+)/i);
    if (d) {
      const parts = [d[1], d[2], d[3]].filter(Boolean).map(Number);
      durationSeconds =
        parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    }
  }

  if (!title) {
    throw new Error('Could not read the track title from that Apple Music link.');
  }

  return {
    searchQuery: artist ? `${artist} - ${title}` : title,
    title,
    artist,
    thumbnail,
    durationSeconds,
  };
}
