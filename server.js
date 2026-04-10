"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;
const DOWNLOADS = path.join(__dirname, "downloads");
// Use env vars for paths — falls back to Mac dev paths locally
const YTDLP =
  process.env.YTDLP_PATH ||
  "/Library/Frameworks/Python.framework/Versions/3.12/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || `${process.env.HOME}/.spotdl/ffmpeg`;

if (!fs.existsSync(DOWNLOADS)) fs.mkdirSync(DOWNLOADS, { recursive: true });

// Write YouTube cookies from env var to temp file (avoids IP rate limits on cloud servers)
// Env var is base64-encoded to preserve tabs and newlines
const COOKIES_FILE = "/tmp/yt-cookies.txt";
if (process.env.YOUTUBE_COOKIES) {
  const decoded = Buffer.from(process.env.YOUTUBE_COOKIES, "base64").toString(
    "utf8",
  );
  fs.writeFileSync(COOKIES_FILE, decoded, "utf8");
  console.log("  cookies: written to /tmp/yt-cookies.txt");
} else {
  console.log("  cookies: YOUTUBE_COOKIES not set (anonymous mode)");
}

// Startup diagnostics
console.log(`  yt-dlp path : ${YTDLP}`);
console.log(`  ffmpeg path : ${FFMPEG}`);
console.log(`  yt-dlp exists: ${fs.existsSync(YTDLP)}`);
console.log(`  ffmpeg exists: ${fs.existsSync(FFMPEG)}`);

// Test yt-dlp binary at startup
const { spawnSync } = require("child_process");
const test = spawnSync(YTDLP, ["--version"], { timeout: 10000 });
if (test.error) {
  console.error(`  yt-dlp ERROR: ${test.error.message}`);
} else {
  console.log(
    `  yt-dlp version: ${(test.stdout || "").toString().trim() || "(no output)"}`,
  );
  if (test.stderr?.length)
    console.log(`  yt-dlp stderr: ${test.stderr.toString().trim()}`);
  console.log(`  yt-dlp exit code: ${test.status}`);
}

app.use(cors());
app.use(express.json());
app.use("/downloads", express.static(DOWNLOADS));

// ── State ──────────────────────────────────────────────────────────────────
const tasks = new Map();
const queue = [];
let isProcessing = false;
const sseClients = new Map();

// ── SSE helpers ────────────────────────────────────────────────────────────
function sendSSE(id, payload) {
  const c = sseClients.get(id);
  if (c && !c.writableEnded) c.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function closeSSE(id) {
  const c = sseClients.get(id);
  if (c && !c.writableEnded) c.end();
  sseClients.delete(id);
}
function logTask(id, line) {
  const t = tasks.get(id);
  if (!t) return;
  t.log.push(line);
  sendSSE(id, { type: "log", line });
}

// ── Spotify metadata scraper (no API key needed) ───────────────────────────
function fetchUrl(url, acceptJson) {
  return new Promise((resolve, reject) => {
    const clean = url.split("?")[0];
    const opts = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: acceptJson ? "application/json" : "text/html",
      },
    };
    const req = https.get(clean, opts, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        return fetchUrl(res.headers.location, acceptJson)
          .then(resolve)
          .catch(reject);
      }
      let data = "";
      res.on("data", (c) => {
        data += c;
      });
      res.on("end", () => resolve(data));
    });
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.on("error", reject);
  });
}

async function getSpotifyMeta(url) {
  const clean = url.split("?")[0];
  const m = clean.match(
    /spotify\.com\/(track|album|playlist|artist)\/([A-Za-z0-9]+)/i,
  );
  if (!m) throw new Error("Neplatný Spotify URL");
  const [, type, id] = m;

  // 1. Try oEmbed — simple JSON, less likely to be blocked
  try {
    const oembed = await fetchUrl(
      `https://open.spotify.com/oembed?url=https://open.spotify.com/${type}/${id}`,
      true,
    );
    const j = JSON.parse(oembed);
    // oEmbed title: "Track Name" + author_name: "Artist Name"
    if (j.title) {
      return {
        title: decodeHtmlEntities(j.title),
        artist: decodeHtmlEntities(j.author_name ?? ""),
      };
    }
  } catch (_) {
    /* fall through */
  }

  // 2. Fallback — embed page scraping
  const html = await fetchUrl(
    `https://open.spotify.com/embed/${type}/${id}`,
    false,
  );

  const full = html.match(
    /"name":"([^"]+)"[^[\]{}]*?"artists"\s*:\s*\[\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/s,
  );
  if (full)
    return {
      title: decodeHtmlEntities(full[1]),
      artist: decodeHtmlEntities(full[2]),
    };

  const nameOnly = html.match(/"name"\s*:\s*"([^"]+)"/);
  if (nameOnly) return { title: decodeHtmlEntities(nameOnly[1]), artist: "" };

  throw new Error("Nepodařilo se načíst metadata ze Spotify");
}

function decodeHtmlEntities(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function sanitizeFilename(s) {
  return s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function snapshotMp3s() {
  return new Set(fs.readdirSync(DOWNLOADS).filter((f) => f.endsWith(".mp3")));
}

// ── Queue processor ────────────────────────────────────────────────────────
async function processQueue() {
  if (isProcessing) return;

  const taskId = queue.find((id) => tasks.get(id)?.status === "waiting");
  if (!taskId) return;

  isProcessing = true;
  const task = tasks.get(taskId);
  task.status = "downloading";
  task.log = [];

  logTask(taskId, "⏳ Načítám informace o skladbě ze Spotify…");

  // 1. Get metadata from Spotify public page
  let searchQuery, outputBase;
  try {
    const meta = await getSpotifyMeta(task.url);
    outputBase = sanitizeFilename(
      meta.artist ? `${meta.artist} - ${meta.title}` : meta.title,
    );
    searchQuery = `ytsearch1:${meta.artist ? meta.artist + " - " : ""}${meta.title}`;
    task.label = outputBase;
    logTask(taskId, `🎵 Nalezeno: ${outputBase}`);
  } catch (e) {
    task.status = "error";
    task.error = `Nepodařilo se načíst metadata ze Spotify: ${e.message}`;
    sendSSE(taskId, { type: "status", status: "error", error: task.error });
    closeSSE(taskId);
    isProcessing = false;
    processQueue();
    return;
  }

  logTask(taskId, "🔍 Hledám na YouTube Music…");

  const before = snapshotMp3s();

  const args = [
    searchQuery,
    "--format",
    "bestaudio/best", // nejlepší dostupný audio stream (opus/m4a)
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0", // VBR nejvyšší kvalita
    "--postprocessor-args",
    "ffmpeg:-b:a 320k", // vynutit 320 kbps na výstupu
    "--ffmpeg-location",
    FFMPEG,
    "--output",
    `${outputBase}.%(ext)s`,
    "--no-playlist",
    "--no-warnings",
    "--newline",
    ...(fs.existsSync(COOKIES_FILE) ? ["--cookies", COOKIES_FILE] : []),
  ];

  const proc = spawn(YTDLP, args, { cwd: DOWNLOADS });

  function onData(data) {
    const lines = data
      .toString()
      .split("\n")
      .filter((l) => l.trim());
    lines.forEach((line) => logTask(taskId, line));
  }
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  proc.on("error", (err) => {
    task.status = "error";
    task.error =
      err.code === "ENOENT" ? "yt-dlp není nainstalován." : err.message;
    sendSSE(taskId, { type: "status", status: "error", error: task.error });
    closeSSE(taskId);
    isProcessing = false;
    processQueue();
  });

  proc.on("close", (code) => {
    if (code === 0) {
      task.status = "done";
      const after = snapshotMp3s();
      const newFiles = [...after].filter((f) => !before.has(f));
      const sorted = (newFiles.length ? newFiles : [...after]).sort((a, b) => {
        return (
          fs.statSync(path.join(DOWNLOADS, b)).mtimeMs -
          fs.statSync(path.join(DOWNLOADS, a)).mtimeMs
        );
      });
      task.filename = sorted[0] ?? null;
    } else {
      task.status = "error";
      task.error =
        task.log
          .filter(
            (l) =>
              !l.startsWith("⏳") && !l.startsWith("🎵") && !l.startsWith("🔍"),
          )
          .slice(-4)
          .join("\n") || `yt-dlp skončil s kódem ${code}`;
    }

    sendSSE(taskId, {
      type: "status",
      status: task.status,
      filename: task.filename,
      error: task.error,
    });
    closeSSE(taskId);
    isProcessing = false;
    processQueue();
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

// POST /api/resolve — resolve playlist/album URL via Spotify embed (no API key needed)
app.post("/api/resolve", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Chybí url" });

  const clean = url.trim().split("?")[0];
  const m = clean.match(
    /spotify\.com\/(track|album|playlist|artist)\/([A-Za-z0-9]+)/i,
  );
  if (!m) return res.status(400).json({ error: "Neplatný Spotify URL" });
  const [, type, id] = m;

  try {
    const html = await fetchUrl(
      `https://open.spotify.com/embed/${type}/${id}`,
      false,
    );

    // Parse __NEXT_DATA__ JSON embedded in the page
    const nextData = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/,
    )?.[1];
    if (!nextData)
      throw new Error("Nepodařilo se načíst data ze Spotify embed stránky");

    const json = JSON.parse(nextData);
    const entity = json?.props?.pageProps?.state?.data?.entity;
    const trackList = entity?.trackList;

    if (!trackList?.length)
      throw new Error("Playlist je prázdný nebo nepřístupný");

    const tracks = trackList.map((t) => ({
      name: decodeHtmlEntities(t.title ?? ""),
      artists: decodeHtmlEntities(t.subtitle ?? ""),
      url: t.uri.startsWith("spotify:track:")
        ? `https://open.spotify.com/track/${t.uri.replace("spotify:track:", "")}`
        : t.uri,
      album: "",
      duration: Math.round((t.duration ?? 0) / 1000),
    }));

    res.json({ tracks, playlistName: entity?.name ?? "" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/queue
app.post("/api/queue", (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || !urls.length)
    return res.status(400).json({ error: "Chybí urls" });

  const taskIds = urls
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter(Boolean)
    .map((url) => {
      const id = randomUUID();
      tasks.set(id, {
        id,
        url,
        status: "waiting",
        log: [],
        filename: null,
        error: null,
        createdAt: Date.now(),
      });
      queue.push(id);
      return id;
    });
  res.json({ taskIds });
});

// POST /api/start-all
app.post("/api/start-all", (_req, res) => {
  processQueue();
  res.json({ ok: true });
});

// POST /api/start/:id
app.post("/api/start/:id", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "Task nenalezen" });
  if (task.status !== "waiting")
    return res.status(400).json({ error: "Není ve stavu waiting" });
  processQueue();
  res.json({ ok: true });
});

// GET /api/status
app.get("/api/status", (_req, res) => {
  res.json({
    tasks: queue.map((id) => {
      const t = tasks.get(id);
      return {
        id: t.id,
        url: t.url,
        status: t.status,
        filename: t.filename,
        error: t.error,
        logTail: t.log.slice(-5),
      };
    }),
  });
});

// GET /api/progress/:id — SSE
app.get("/api/progress/:id", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "Task nenalezen" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  task.log.forEach((line) =>
    res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`),
  );

  if (task.status === "done" || task.status === "error") {
    res.write(
      `data: ${JSON.stringify({ type: "status", status: task.status, filename: task.filename, error: task.error })}\n\n`,
    );
    return res.end();
  }

  sseClients.set(req.params.id, res);
  req.on("close", () => sseClients.delete(req.params.id));
});

// GET /api/files
app.get("/api/files", (_req, res) => {
  try {
    const files = fs
      .readdirSync(DOWNLOADS)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => {
        const s = fs.statSync(path.join(DOWNLOADS, f));
        return { name: f, size: s.size, date: s.mtime };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ files });
  } catch {
    res.json({ files: [] });
  }
});

// DELETE /api/files
app.delete("/api/files", (_req, res) => {
  try {
    const removed = fs.readdirSync(DOWNLOADS).filter((f) => f.endsWith(".mp3"));
    removed.forEach((f) => fs.unlinkSync(path.join(DOWNLOADS, f)));
    res.json({ deleted: removed.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () =>
  console.log(`\n  SpotiSave ▶  http://localhost:${PORT}\n`),
);
