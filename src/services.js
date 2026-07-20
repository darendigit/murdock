/**
 * Service detection: map an arbitrary pasted URL onto a known provider.
 *
 * `direct` providers can be handed straight to yt-dlp.
 * `resolve` providers (Spotify) have DRM-protected streams and must be
 * resolved to a searchable title first — see src/spotify.js.
 */

const PROVIDERS = [
  {
    id: 'youtube',
    label: 'YouTube',
    mode: 'direct',
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'],
  },
  {
    id: 'spotify',
    label: 'Spotify',
    mode: 'resolve',
    hosts: ['open.spotify.com', 'play.spotify.com', 'spotify.link'],
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    mode: 'direct',
    hosts: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'],
  },
  {
    id: 'instagram',
    label: 'Instagram',
    mode: 'direct',
    hosts: ['instagram.com', 'www.instagram.com', 'instagr.am', 'ddinstagram.com'],
  },
  {
    id: 'twitter',
    label: 'X / Twitter',
    mode: 'direct',
    hosts: ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com', 'mobile.twitter.com', 't.co'],
  },
  {
    id: 'soundcloud',
    label: 'SoundCloud',
    mode: 'direct',
    hosts: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'],
  },
  {
    id: 'bandcamp',
    label: 'Bandcamp',
    mode: 'direct',
    hostSuffixes: ['bandcamp.com'],
  },
  {
    id: 'vimeo',
    label: 'Vimeo',
    mode: 'direct',
    hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
  },
  {
    id: 'facebook',
    label: 'Facebook',
    mode: 'direct',
    hosts: ['facebook.com', 'www.facebook.com', 'fb.watch', 'm.facebook.com'],
  },
  {
    id: 'reddit',
    label: 'Reddit',
    mode: 'direct',
    hosts: ['reddit.com', 'www.reddit.com', 'v.redd.it', 'old.reddit.com'],
  },
  {
    id: 'twitch',
    label: 'Twitch',
    mode: 'direct',
    hosts: ['twitch.tv', 'www.twitch.tv', 'clips.twitch.tv', 'm.twitch.tv'],
  },
  {
    id: 'mixcloud',
    label: 'Mixcloud',
    mode: 'direct',
    hosts: ['mixcloud.com', 'www.mixcloud.com'],
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
        supported: true,
      };
    }
  }

  return {
    id: 'unknown',
    label: url.hostname,
    mode: 'direct',
    url: url.toString(),
    supported: false,
  };
}

export function listProviders() {
  return PROVIDERS.map(({ id, label, mode }) => ({ id, label, mode }));
}
