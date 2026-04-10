FROM node:20-slim

# Cache bust: 2026-04-10b
ARG CACHEBUST=20260410b

# Install ffmpeg + python3 + pip
RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (no curl/SSL issues)
RUN pip3 install --break-system-packages yt-dlp && \
    yt-dlp --version

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p downloads

ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3001
CMD ["node", "server.js"]
