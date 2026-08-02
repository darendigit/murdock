/**
 * Spotify resolver.
 *
 * Spotify's audio streams are DRM-protected (Widevine) and cannot be pulled
 * directly — no tool can, yt-dlp included. What we can do is read the public
 * metadata for the track and hand a "<artist> <title>" search to yt-dlp, which
 * matches it against YouTube. That's the same approach spotdl takes.
 *
 * No API key required. Metadata comes from the embed page's __NEXT_DATA__
 * payload — open.spotify.com/track/... is a client-rendered SPA whose raw HTML
 * carries no OpenGraph tags, so scraping that page yields nothing usable.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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

/** Pull {kind, id} out of any Spotify URL shape, including /intl-xx/ variants. */
function parseSpotifyUrl(spotifyUrl) {
  const match = spotifyUrl.match(
    /open\.spotify\.com\/(?:intl-[\w-]+\/)?(track|episode)\/([A-Za-z0-9]+)/
  );
  if (match) return { kind: match[1], id: match[2] };

  const other = spotifyUrl.match(
    /open\.spotify\.com\/(?:intl-[\w-]+\/)?(\w+)\//
  );
  if (other) return { kind: other[1], id: null };

  return { kind: null, id: null };
}

/** Follow spotify.link / spotify short URLs to the canonical open.spotify.com URL. */
async function resolveShortLink(spotifyUrl) {
  if (!/spotify\.link|\/\/spoti\.fi/.test(spotifyUrl)) return spotifyUrl;
  try {
    const res = await fetchWithTimeout(spotifyUrl);
    return res.url || spotifyUrl;
  } catch {
    return spotifyUrl;
  }
}

/**
 * Turn a Spotify URL into a YouTube search term plus display metadata.
 * Returns { searchQuery, title, artist, thumbnail, durationSeconds }.
 */
export async function resolveSpotify(rawUrl) {
  const spotifyUrl = await resolveShortLink(rawUrl);
  const { kind, id } = parseSpotifyUrl(spotifyUrl);

  if (kind && kind !== 'track' && kind !== 'episode') {
    throw new Error(
      `Spotify ${kind}s aren't supported yet — paste a link to a single track.`
    );
  }

  if (!id) {
    throw new Error('Could not read a track id from that Spotify link.');
  }

  const res = await fetchWithTimeout(`https://open.spotify.com/embed/${kind}/${id}`);
  if (!res.ok) {
    throw new Error(
      `Spotify returned ${res.status} for that link. It may be region-locked or removed.`
    );
  }

  const html = await res.text();
  const payload = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  )?.[1];

  if (!payload) {
    throw new Error('Spotify changed its embed format — the resolver needs updating.');
  }

  let entity;
  try {
    entity = JSON.parse(payload)?.props?.pageProps?.state?.data?.entity;
  } catch {
    throw new Error('Could not parse Spotify metadata.');
  }

  const title = entity?.name || entity?.title;
  if (!title) {
    throw new Error('Could not read the track title from that Spotify link.');
  }

  const artist = entity?.artists?.map((a) => a.name).filter(Boolean).join(' ') || null;
  const thumbnail =
    entity?.visualIdentity?.image?.slice()?.sort((a, b) => b.maxWidth - a.maxWidth)?.[0]?.url ||
    null;
  const durationSeconds =
    typeof entity?.duration === 'number' ? Math.round(entity.duration / 1000) : null;

  return {
    searchQuery: artist ? `${artist} - ${title}` : title,
    title,
    artist,
    thumbnail,
    durationSeconds,
  };
}

/**
 * yt-dlp search target. `ytsearch1:` makes yt-dlp pick the top YouTube result
 * and treat it as the media to download.
 */
export function toSearchTarget(searchQuery) {
  return `ytsearch1:${searchQuery}`;
}

/** Pull {kind, id} for a playlist or album URL. */
function parseCollectionUrl(spotifyUrl) {
  const m = spotifyUrl.match(/open\.spotify\.com\/(?:intl-[\w-]+\/)?(playlist|album)\/([A-Za-z0-9]+)/);
  return m ? { kind: m[1], id: m[2] } : { kind: null, id: null };
}

/**
 * Enumerate a Spotify playlist or album into a list of YouTube search targets.
 * Reads the public embed's __NEXT_DATA__ trackList — same no-auth path as a
 * single track. Returns { title, tracks: [{ searchQuery, title, artist }] }.
 */
export async function resolveSpotifyPlaylist(rawUrl) {
  const spotifyUrl = await resolveShortLink(rawUrl);
  const { kind, id } = parseCollectionUrl(spotifyUrl);
  if (!kind || !id) {
    throw new Error('That doesn’t look like a Spotify playlist or album link.');
  }

  const res = await fetchWithTimeout(`https://open.spotify.com/embed/${kind}/${id}`);
  if (!res.ok) {
    throw new Error(`Spotify returned ${res.status} for that ${kind}. It may be private or removed.`);
  }
  const html = await res.text();
  const payload = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!payload) throw new Error('Spotify changed its embed format — the resolver needs updating.');

  let entity;
  try {
    entity = JSON.parse(payload)?.props?.pageProps?.state?.data?.entity;
  } catch {
    throw new Error('Could not parse Spotify metadata.');
  }

  const title = entity?.name || entity?.title || `Spotify ${kind}`;
  const list = entity?.trackList || [];
  const tracks = list
    .map((t) => {
      const trackTitle = t?.title || t?.name;
      // subtitle is the artist(s) string on the embed; fall back to artists[].
      const artist =
        t?.subtitle ||
        (Array.isArray(t?.artists) ? t.artists.map((a) => a.name).filter(Boolean).join(' ') : null);
      if (!trackTitle) return null;
      return {
        title: trackTitle,
        artist: artist || null,
        searchQuery: artist ? `${artist} - ${trackTitle}` : trackTitle,
      };
    })
    .filter(Boolean);

  if (tracks.length === 0) throw new Error('No tracks found in that Spotify link.');
  return { title, tracks };
}
