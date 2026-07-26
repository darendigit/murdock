/**
 * Service detection: map an arbitrary pasted URL onto a known provider.
 *
 * `mode`: `direct` providers go straight to yt-dlp; `resolve` (Spotify) has
 * DRM-protected streams and must be resolved to a searchable title first — see
 * src/spotify.js.
 *
 * `tier` (set from the 0.0.4 feasibility gate against the hosted datacenter IP):
 *   - `supported`  — reliably grabbable on the hosted instance.
 *   - `bestEffort` — usually works but may fail (surfaced to the user).
 *   - `unsupported`— hard login/auth-wall no hosted tool can clear; we refuse
 *                    up front with a clear message instead of a raw yt-dlp error.
 *
 * `proxied`: route this provider's yt-dlp calls through the WARP egress proxy
 * (server.js `proxyFor`). Needed for the platforms that block/limit datacenter
 * IPs; the others go direct (WARP only adds latency for them).
 */

const PROVIDERS = [
  {
    id: 'youtube',
    label: 'YouTube',
    mode: 'direct',
    tier: 'supported',
    proxied: true,
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'],
  },
  {
    id: 'spotify',
    label: 'Spotify',
    mode: 'resolve',
    tier: 'supported',
    proxied: true, // resolves to a YouTube search
    hosts: ['open.spotify.com', 'play.spotify.com', 'spotify.link'],
  },
  {
    id: 'applemusic',
    label: 'Apple Music',
    mode: 'resolve',
    tier: 'supported',
    proxied: true, // DRM-protected like Spotify; resolves to a YouTube search
    hosts: ['music.apple.com', 'embed.music.apple.com'],
  },
  {
    id: 'soundcloud',
    label: 'SoundCloud',
    mode: 'direct',
    tier: 'supported',
    proxied: false,
    hosts: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'],
  },
  {
    id: 'bandcamp',
    label: 'Bandcamp',
    mode: 'direct',
    tier: 'supported',
    proxied: false,
    hostSuffixes: ['bandcamp.com'],
  },
  {
    id: 'vimeo',
    label: 'Vimeo',
    mode: 'direct',
    tier: 'supported', // works on yt-dlp nightly (broken on stable)
    proxied: false,
    hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
  },
  {
    id: 'mixcloud',
    label: 'Mixcloud',
    mode: 'direct',
    tier: 'supported', // works on yt-dlp nightly (broken on stable)
    proxied: false,
    hosts: ['mixcloud.com', 'www.mixcloud.com'],
  },
  {
    id: 'reddit',
    label: 'Reddit',
    mode: 'direct',
    tier: 'supported',
    proxied: true, // datacenter IPs get rate-limited
    hosts: ['reddit.com', 'www.reddit.com', 'v.redd.it', 'old.reddit.com'],
  },
  {
    id: 'twitch',
    label: 'Twitch',
    mode: 'direct',
    tier: 'supported',
    proxied: false,
    hosts: ['twitch.tv', 'www.twitch.tv', 'clips.twitch.tv', 'm.twitch.tv'],
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    mode: 'direct',
    tier: 'bestEffort', // rate-limits/region-locks; WARP helps but not guaranteed
    proxied: true,
    hosts: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'],
  },
  {
    id: 'instagram',
    label: 'Instagram',
    mode: 'direct',
    tier: 'unsupported', // login/rate-limit wall no hosted tool clears reliably
    proxied: false,
    hosts: ['instagram.com', 'www.instagram.com', 'instagr.am', 'ddinstagram.com'],
  },
  {
    id: 'twitter',
    label: 'X / Twitter',
    mode: 'direct',
    tier: 'unsupported', // media locked behind login
    proxied: false,
    hosts: ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com', 'mobile.twitter.com', 't.co'],
  },
  {
    id: 'facebook',
    label: 'Facebook',
    mode: 'direct',
    tier: 'unsupported', // login/rate-limit wall
    proxied: false,
    hosts: ['facebook.com', 'www.facebook.com', 'fb.watch', 'm.facebook.com'],
  },
];

/** Parse and normalize a pasted string into a URL, or throw a friendly error. */
export function parseUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    throw new Error('Paste a link first.');
  }

  // Be forgiving about a missing scheme — people copy "youtube.com/watch?v=..."
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`That doesn't look like a link: "${trimmed.slice(0, 80)}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https links are supported.');
  }

  return url;
}

/**
 * Identify which provider a URL belongs to.
 * Unknown hosts fall back to `unknown` with mode `direct` — yt-dlp supports
 * well over a thousand sites, so it's worth attempting rather than refusing.
 */
export function detectService(raw) {
  const url = parseUrl(raw);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  for (const provider of PROVIDERS) {
    const hostMatch = provider.hosts?.some(
      (h) => host === h.replace(/^www\./, '')
    );
    const suffixMatch = provider.hostSuffixes?.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );

    if (hostMatch || suffixMatch) {
      return {
        id: provider.id,
        label: provider.label,
        mode: provider.mode,
        url: url.toString(),
        tier: provider.tier,
        proxied: Boolean(provider.proxied),
      };
    }
  }

  // Unknown host: still worth attempting (yt-dlp covers ~1000 sites). Route it
  // through WARP too, since an unknown datacenter-hostile site is more likely to
  // need it than not.
  return {
    id: 'unknown',
    label: url.hostname,
    mode: 'direct',
    url: url.toString(),
    tier: 'unknown',
    proxied: true,
  };
}

/** Providers exposed to the UI, minus the dropped (unsupported) ones. */
export function listProviders() {
  return PROVIDERS.filter((p) => p.tier !== 'unsupported').map(({ id, label, mode, tier }) => ({
    id,
    label,
    mode,
    tier,
  }));
}
