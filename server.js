
const express = require("express");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SNAPANY_API_KEY;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 20
}));

const sessions = new Map();

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/analyze", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "API key is not configured." });
    }

    const { url } = req.body || {};

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "Enter a valid YouTube URL." });
    }

    const host = parsed.hostname.toLowerCase();
    if (
      !["youtube.com", "www.youtube.com", "m.youtube.com",
        "music.youtube.com", "youtu.be"].includes(host)
    ) {
      return res.status(400).json({ error: "YouTube links only." });
    }

    const response = await fetch(
      "https://api.snapany.com/openapi/v1/youtube/proxy-download",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || data.error || "Video analysis failed."
      });
    }

    const videos = (data.medias || [])
      .filter(media => media.media_type === "video");

    const audios = (data.medias || [])
      .filter(media => media.media_type === "audio");

    const id = require("crypto").randomUUID();

    sessions.set(id, { videos, audios, created: Date.now() });

    res.json({
      id,
      title: data.title || "YouTube video",
      videos: videos.map(media => ({
        quality: media.quality || "Available",
        variants: (media.variants || [])
          .filter(v => v.resource_proxy_url || v.video_proxy_url)
          .map(v => ({
            quality: v.quality,
            url: v.resource_proxy_url || v.video_proxy_url,
            ext: v.video_ext || "mp4"
          }))
      })),
      audioAvailable: audios.some(a => a.resource_proxy_url)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not analyze that video." });
  }
});

app.get("/api/download/:id/:index", async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session expired. Analyze again." });
    }

    const variants = session.videos.flatMap(v => v.variants || []);
    const variant = variants[Number(req.params.index)];

    if (!variant || !variant.resource_proxy_url && !variant.video_proxy_url) {
      return res.status(404).json({ error: "That quality is unavailable." });
    }

    const mediaUrl = variant.resource_proxy_url || variant.video_proxy_url;
    const file = await fetch(mediaUrl);

    if (!file.ok) {
      return res.status(502).json({ error: "The download link expired. Analyze again." });
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="clipdrop-video.mp4"');

    if (file.body) {
      const { Readable } = require("stream");
      Readable.fromWeb(file.body).pipe(res);
    } else {
      res.status(502).end();
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "Download failed." });
  }
});

app.get("/api/audio/:id", async (req, res) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session expired. Analyze again." });
    }

    const audio = session.audios.find(a => a.resource_proxy_url);

    if (!audio) {
      return res.status(404).json({ error: "Audio is unavailable." });
    }

    const file = await fetch(audio.resource_proxy_url);

    if (!file.ok) {
      return res.status(502).json({ error: "Audio link expired. Analyze again." });
    }

    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="clipdrop-audio.m4a"');

    const { Readable } = require("stream");
    Readable.fromWeb(file.body).pipe(res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "Audio download failed." });
  }
});

// Remove expired sessions every 10 minutes.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.created < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`ClipDrop running on port ${PORT}`);
});
