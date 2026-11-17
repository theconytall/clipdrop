
const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SNAPANY_API_KEY;

const sessions = new Map();

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 15
}));

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "ClipDrop" });
});

app.post("/api/analyze", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "SNAPANY_API_KEY is missing in Render environment variables."
      });
    }

    const url = String(req.body?.url || "").trim();

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "Enter a valid YouTube URL." });
    }

    const allowedHosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be"
    ];

    if (
      parsed.protocol !== "https:" ||
      !allowedHosts.includes(parsed.hostname.toLowerCase())
    ) {
      return res.status(400).json({
        error: "Please enter a valid YouTube HTTPS link."
      });
    }

    const response = await fetch(
      "https://api.snapany.com/openapi/v1/youtube/proxy-download",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(60000)
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || data.error || "Video analysis failed."
      });
    }

    const videoMedia = (data.medias || []).filter(
      media => media.media_type === "video"
    );

    const audioMedia = (data.medias || []).filter(
      media => media.media_type === "audio"
    );

    const videos = videoMedia
      .filter(media => media.resource_proxy_url)
      .map(media => ({
        variants: [{
          quality: media.quality_label || "Available video",
          url: media.resource_proxy_url
        }]
      }));

    const audio = audioMedia.find(media => media.resource_proxy_url);

    if (!videos.length && !audio) {
      return res.status(422).json({
        error: "No downloadable proxy files were returned for this video."
      });
    }

    const id = crypto.randomUUID();

    sessions.set(id, {
      videos,
      audio: audio?.resource_proxy_url || null,
      created: Date.now()
    });

    res.json({
      id,
      title: data.title || "YouTube video",
      videos,
      audioAvailable: Boolean(audio)
    });

  } catch (error) {
    console.error("Analyze error:", error);
    res.status(500).json({
      error: "Could not analyze the video. Please try again."
    });
  }
});

async function streamProxyFile(url, res, filename, contentType) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok || !response.body) {
    throw new Error(`Media provider returned HTTP ${response.status}`);
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );

  await pipeline(Readable.fromWeb(response.body), res);
}

app.get("/api/download/:id/:index", async (req, res) => {
  try {
    const session = sessions.get(req.params.id);

    if (!session) {
      return res.status(404).json({
        error: "Download session expired. Analyze the video again."
      });
    }

    const index = Number(req.params.index);
    const variant = session.videos[index]?.variants?.[0];

    if (!variant?.url) {
      return res.status(404).json({
        error: "That video format is unavailable."
      });
    }

    await streamProxyFile(
      variant.url,
      res,
      "clipdrop-video.mp4",
      "video/mp4"
    );

  } catch (error) {
    console.error("Video download error:", error);

    if (!res.headersSent) {
      res.status(502).json({
        error: "Video download failed. Analyze the video again."
      });
    }
  }
});

app.get("/api/audio/:id", async (req, res) => {
  try {
    const session = sessions.get(req.params.id);

    if (!session || !session.audio) {
      return res.status(404).json({
        error: "Audio is unavailable. Analyze the video again."
      });
    }

    await streamProxyFile(
      session.audio,
      res,
      "clipdrop-audio.m4a",
      "audio/mp4"
    );

  } catch (error) {
    console.error("Audio download error:", error);

    if (!res.headersSent) {
      res.status(502).json({
        error: "Audio download failed. Analyze the video again."
      });
    }
  }
});

// Remove expired sessions.
setInterval(() => {
  const cutoff = Date.now() - 25 * 60 * 1000;

  for (const [id, session] of sessions) {
    if (session.created < cutoff) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`ClipDrop running on port ${PORT}`);
});
