FROM node:20-slim

# Install ffmpeg + curl
RUN apt-get update && apt-get install -y \
    ffmpeg curl \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Download yt-dlp standalone binary (no Python needed)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p downloads

ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3001
CMD ["node", "server.js"]
