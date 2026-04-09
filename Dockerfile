FROM node:20-slim

# Install Python, pip, ffmpeg
RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install yt-dlp --break-system-packages

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p downloads

ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3001
CMD ["node", "server.js"]
