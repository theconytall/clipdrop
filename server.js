
const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { pipeline } = require("stream/promises");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SNAPANY_API_KEY;

const sessions = new Map();

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", rateLimit({
  windowMs: 60000,
  limit: 15
}));

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "ClipDrop" });
});

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok || !response.body) {
    throw new Error(`Media download failed: HTTP ${response.status}`);
  }

  await pipeline(
    response.body,
    fs.createWriteStream(destination)
  );
}

function mergeMedia(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-i", audioPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath
    ]);

    let errorOutput = "";

    ffmpeg.stderr.on("data", chunk => {
      errorOutput += chunk.toString();
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(errorOutput || `FFmpeg exited ${code}`));
    });
  });
}

app.post("/api/analyze", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "API key is not configured in Render."
      });
    }

    const url = String(req.body?.url || "").trim();

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL." });
    }

    const hosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be"
    ];

    if (
      parsed.protocol !== "https:" ||
      !hosts.includes(parsed.hostname.toLowerCase())
    ) {
      return res.status(400).json({
        error: "Please enter a valid YouTube HTTPS URL."
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
        error: data.message || data.error || "SnapAny analysis failed."
      });
    }

    const media = data.medias || [];
    const videoMedia = media.find(m => m.media_type === "video");
    const audioMedia = media.find(m => m.media_type === "audio");

    if (!videoMedia) {
      return res.status(404).json({
        error: "No video was found."
      });
    }

    const variants = (videoMedia.variants || [])
      .filter(v => v.video_proxy_url)
      .sort((a, b) => Number(a.quality) - Number(b.quality))
      .map(v => ({
        quality: v.quality_label || `${v.quality}p`,
        videoUrl: v.video_proxy_url,
        audioUrl: v.audio_proxy_url || null
      }));

    // Fallback to a complete proxy media file if no variants exist.
    if (!variants.length && videoMedia.resource_proxy_url) {
      variants.push({
        quality: "Available quality",
        videoUrl: videoMedia.resource_proxy_url,
        audioUrl: null
      });
    }

    if (!variants.length) {
      return res.status(404).json({
        error: "No supported proxy video formats were returned."
      });
    }

    const id = crypto.randomUUID();

    sessions.set(id, {
      variants,
      audioUrl: audioMedia?.resource_proxy_url || null,
      created: Date.now()
    });

    res.json({
      id,
      title: data.title || "YouTube video",
      videos: variants.map(v => ({
        variants: [{ quality: v.quality }]
      })),
      audioAvailable: Boolean(audioMedia?.resource_proxy_url)
    });

  } catch (error) {
    console.error("Analyze error:", error);
    res.status(500).json({
      error: "Video analysis failed. Please try again."
    });
  }
});

app.get("/api/download/:id/:index", async (req, res) => {
  let directory;

  try {
    const session = sessions.get(req.params.id);

    if (!session) {
      return res.status(404).json({
        error: "Session expired. Analyze the video again."
      });
    }

    const index = Number(req.params.index);
    const variant = session.variants[index];

    if (!variant) {
      return res.status(404).json({
        error: "Video quality unavailable."
      });
    }

    directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "clipdrop-")
    );

    const videoPath = path.join(directory, "video.mp4");
    const audioPath = path.join(directory, "audio.m4a");
    const outputPath = path.join(directory, "output.mp4");

    await downloadFile(variant.videoUrl, videoPath);

    if (variant.audioUrl) {
      await downloadFile(variant.audioUrl, audioPath);
      await mergeMedia(videoPath, audioPath, outputPath);
    } else {
      await fs.promises.rename(videoPath, outputPath);
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="clipdrop-video.mp4"'
    );

    await pipeline(
      fs.createReadStream(outputPath),
      res
    );

  } catch (error) {
    console.error("Video download error:", error);

    if (!res.headersSent) {
      res.status(502).json({
        error: "Video download failed. Please analyze it again."
      });
    }
  } finally {
    if (directory) {
      await fs.promises.rm(directory, {
        recursive: true,
        force: true
      }).catch(() => {});
    }
  }
});

app.get("/api/audio/:id", async (req, res) => {
  let directory;

  try {
    const session = sessions.get(req.params.id);

    if (!session?.audioUrl) {
      return res.status(404).json({
        error: "Audio is unavailable."
      });
    }

    directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "clipdrop-")
    );

    const audioPath = path.join(directory, "audio.m4a");

    await downloadFile(session.audioUrl, audioPath);

    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="clipdrop-audio.m4a"'
    );

    await pipeline(
      fs.createReadStream(audioPath),
      res
    );

  } catch (error) {
    console.error("Audio download error:", error);

    if (!res.headersSent) {
      res.status(502).json({
        error: "Audio download failed."
      });
    }
  } finally {
    if (directory) {
      await fs.promises.rm(directory, {
        recursive: true,
        force: true
      }).catch(() => {});
    }
  }
});

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;

  for (const [id, session] of sessions) {
    if (session.created < cutoff) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`ClipDrop running on port ${PORT}`);
});
