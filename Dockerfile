# murdock — container image for hosted deployment (Render, Fly, any Docker host).
#
# Two binaries do the real work and neither ships with Node: ffmpeg for
# transcoding, yt-dlp for extraction.
#
# yt-dlp is installed via pip into a venv rather than the standalone
# `yt-dlp_linux` build. That build is a PyInstaller bundle that self-extracts
# ~30MB to a temp dir on EVERY invocation; on a throttled free-tier CPU that
# blew past the version-check timeout and wedged the service. The pip package
# runs through the interpreter with no per-call unpacking — it starts in well
# under a second.

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

# yt-dlp lives in its own venv so a `pip install` upgrade never touches system
# Python. PATH is prepended so `yt-dlp` resolves to it.
ENV PATH="/opt/ytdlp-venv/bin:${PATH}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-venv \
 && python3 -m venv /opt/ytdlp-venv \
 && /opt/ytdlp-venv/bin/pip install --no-cache-dir --upgrade pip yt-dlp \
 && /opt/ytdlp-venv/bin/yt-dlp --version \
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
