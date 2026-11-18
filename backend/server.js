
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    app: "ClipDrop",
    status: "running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    app: "ClipDrop",
    status: "running"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipDrop running on port ${PORT}`);
});
