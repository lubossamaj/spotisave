FROM node:20-slim

# Cache bust: 2026-04-10
ARG CACHEBUST=20260410

# Install ffmpeg + curl
RUN apt-get update && apt-get install -y \
    ffmpeg curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Download yt-dlp standalone binary (pinned version — avoids /latest/ redirect failures)
RUN curl -L --retry 3 --retry-delay 2 \
    https://github.com/yt-dlp/yt-dlp/releases/download/2025.03.31/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p downloads

ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3001
CMD ["node", "server.js"]
