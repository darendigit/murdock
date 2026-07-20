# murdock — container image for hosted deployment (Render, Fly, any Docker host).
#
# Two binaries do the real work and neither ships with Node, so they are
# installed explicitly: ffmpeg for transcoding, yt-dlp for extraction.
# yt-dlp uses the standalone Linux build, which bundles its own Python — that
# keeps the image smaller than installing python3 + pip just to get it.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    # Hosted instances are scratch buffers: sweep files on a TTL. This is the
    # opt-in that local installs deliberately do not set.
    MURDOCK_EPHEMERAL=1 \
    MURDOCK_DOWNLOAD_DIR=/tmp/murdock \
    MURDOCK_TTL_MINUTES=30 \
    MURDOCK_MAX_DISK_MB=400 \
    # 512MB hosts cannot survive many parallel transcodes.
    MURDOCK_MAX_CONCURRENT=2

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so dependency layers cache across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Run unprivileged. The node image already provides uid 1000 as `node`.
RUN mkdir -p /tmp/murdock && chown -R node:node /tmp/murdock /app
USER node

# Render injects PORT; the server falls back to 5757 elsewhere.
EXPOSE 5757

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5757)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
