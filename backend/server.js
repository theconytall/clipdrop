
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("ClipDrop backend is running!");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "ClipDrop"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipDrop running on port ${PORT}`);
});
