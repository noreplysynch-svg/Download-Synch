const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const OWNER_PIN = process.env.OWNER_PIN || "changeme";

// Railway note: the default filesystem is EPHEMERAL and wipes on every
// redeploy. Attach a Railway Volume and point UPLOAD_DIR / DB_PATH at it
// (e.g. mounted at /data) so uploaded APKs and the metadata survive deploys.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const VALID_APP_IDS = new Set(["downloader", "vpn", "message"]);

// ---------- Tiny JSON "database" ----------
function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return {};
  }
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}
if (!fs.existsSync(DB_PATH)) writeDB({});

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// ---------- Auth middleware for admin actions ----------
function requirePin(req, res, next) {
  const pin = req.header("x-owner-pin");
  if (!pin || pin !== OWNER_PIN) {
    return res.status(401).json({ error: "Invalid or missing PIN" });
  }
  next();
}

// ---------- Multer: temp storage, we rename after validating appId ----------
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB ceiling, adjust as needed
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".apk")) {
      return cb(new Error("Only .apk files are allowed"));
    }
    cb(null, true);
  }
});

// ---------- Public: verify PIN (used to gate the upload screen) ----------
app.post("/api/verify-pin", express.json(), (req, res) => {
  const pin = req.header("x-owner-pin");
  if (!pin || pin !== OWNER_PIN) {
    return res.status(401).json({ error: "Incorrect PIN" });
  }
  res.json({ ok: true });
});

// ---------- Public: list current apps (metadata only) ----------
app.get("/api/apps", (req, res) => {
  res.json(readDB());
});

// ---------- Public: download ----------
app.get("/api/apps/:appId/download", (req, res) => {
  const { appId } = req.params;
  const record = readDB()[appId];
  if (!record) return res.status(404).json({ error: "No file uploaded for this app yet" });

  const filePath = path.join(UPLOAD_DIR, record.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing on server" });

  res.download(filePath, record.fileName);
});

// ---------- Admin: upload / replace ----------
app.post("/api/apps/:appId", requirePin, upload.single("file"), (req, res) => {
  const { appId } = req.params;

  if (!VALID_APP_IDS.has(appId)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "Unknown app id" });
  }
  if (!req.file) return res.status(400).json({ error: "No file received" });

  const db = readDB();

  // Replace any previous file for this appId
  if (db[appId]) {
    fs.unlink(path.join(UPLOAD_DIR, db[appId].storedName), () => {});
  }

  const storedName = `${appId}-${Date.now()}.apk`;
  fs.renameSync(req.file.path, path.join(UPLOAD_DIR, storedName));

  db[appId] = {
    fileName: req.file.originalname,
    storedName,
    size: req.file.size,
    uploadedAt: new Date().toISOString()
  };
  writeDB(db);

  res.json({ ok: true });
});

// ---------- Admin: remove ----------
app.delete("/api/apps/:appId", requirePin, (req, res) => {
  const { appId } = req.params;
  const db = readDB();
  if (db[appId]) {
    fs.unlink(path.join(UPLOAD_DIR, db[appId].storedName), () => {});
    delete db[appId];
    writeDB(db);
  }
  res.json({ ok: true });
});

// Fallback error handler (multer errors etc.)
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || "Upload failed" });
});

// Node kills requests at 5 minutes by default — too short for a 200MB+ upload
// on a slow connection. Raise it toward Railway's 15-minute platform ceiling.
const server = app.listen(PORT, () => console.log(`Synch downloads server running on port ${PORT}`));
server.requestTimeout = 14 * 60 * 1000; // 14 min, just under Railway's 15 min platform max
server.headersTimeout = 14 * 60 * 1000 + 5000; // must be >= requestTimeout
