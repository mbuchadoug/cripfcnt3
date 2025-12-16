// server.js — merged, local + prod friendly, restores auth/admin + render-wrapper
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { engine } from "express-handlebars";
import mongoose from "mongoose";
import session from "express-session";
import MongoStore from "connect-mongo";
import cookieParser from "cookie-parser";
import passport from "passport";

dotenv.config();

import { ensureVisitorId } from "./middleware/visitorId.js";
import { visitTracker } from "./middleware/visits.js";
import { ensureAuth } from "./middleware/authGuard.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import configurePassport from "./config/passport.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------- basic middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser()); // parse cookies (once)

// ---------- small defensive render wrapper (prevents express-handlebars crash) ----------
app.use((req, res, next) => {
  // ensure req.next exists for any library expecting it
  if (typeof req.next !== "function") req.next = next;

  // wrap res.render so template errors call the real next(err)
  const origRender = res.render && res.render.bind(res);
  res.render = function patchedRender(view, opts, cb) {
    try {
      if (!origRender) {
        const err = new Error("res.render not available");
        return next(err);
      }
      // normalize arguments like express
      if (typeof opts === "function") {
        cb = opts;
        opts = undefined;
      }
      return origRender(view, opts, function renderCallback(err, html) {
        if (err) {
          return next(err); // call real next(err) — avoids req.next issue
        }
        if (typeof cb === "function") return cb(null, html);
        if (!res.headersSent) return res.send(html);
      });
    } catch (err) {
      return next(err);
    }
  };
  next();
});

// ---------- handlebars ----------
app.engine(
  "hbs",
  engine({
    extname: ".hbs",
    defaultLayout: "main",
    layoutsDir: path.join(__dirname, "views", "layouts"),
    partialsDir: path.join(__dirname, "views", "partials"),
    helpers: {
      eq: (a, b) => String(a) === String(b),
      formatDate: (d) => {
        if (!d) return "";
        try {
          return new Date(d).toISOString().slice(0, 10);
        } catch (e) {
          return String(d);
        }
      },
    },
  })
);
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// ---------- OpenAI client (optional) ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// ensure data dir exists (used by audits or other utilities)
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath), { recursive: true });

// ---------- Mongo & sessions ----------
const mongoUri = process.env.MONGODB_URI || "";
if (mongoUri) {
  mongoose.set("strictQuery", true);
  mongoose
    .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((err) => console.error("❌ MongoDB connection failed:", err && err.message ? err.message : err));
} else {
  console.warn("⚠️ MONGODB_URI not set — sessions will use MemoryStore (not for production).");
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    store: mongoUri ? MongoStore.create({ mongoUrl: mongoUri }) : undefined,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  })
);

// ---------- passport (configure then initialize) ----------
try {
  configurePassport(); // ensure this registers strategies and serialize/deserialize
} catch (e) {
  console.error("configurePassport() threw:", e && e.stack ? e.stack : e);
}
app.use(passport.initialize());
app.use(passport.session());

// ---------- visitor id + tracking (needs cookies and session mounted) ----------
app.use(ensureVisitorId);
app.use(visitTracker);

// ---------- diagnostics & public routes (kept like v5) ----------
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/debug/ping", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- mount auth + admin (must be after passport.session()) ----------
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);

// ---------- small debug route to see current user ----------
app.get("/api/whoami", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.json({ authenticated: false });
});

// ---------- site pages (like your working v5) ----------
app.get("/", (req, res) => {
  try {
    // try website/index, then landing, then fallback to public/index.html
    const candidates = [
      path.join(app.get("views"), "website", "index.hbs"),
      path.join(app.get("views"), "landing.hbs"),
      path.join(app.get("views"), "index.hbs"),
      path.join(__dirname, "public", "index.html"),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      return res.status(200).send(`<h3>No homepage template found</h3>
        <p>Create views/website/index.hbs or public/index.html</p>`);
    }
    if (found.endsWith("public/index.html")) return res.sendFile(found);
    const rel = path.relative(app.get("views"), found).replace(/\.hbs$/, "").split(path.sep).join("/");
    return res.render(rel, { user: req.user || null });
  } catch (err) {
    console.error("GET / render error:", err && err.stack ? err.stack : err);
    return res.status(500).send("Server error rendering homepage");
  }
});

app.get("/about", (req, res) => res.render("website/about", { user: req.user || null }));
app.get("/services", (req, res) => res.render("website/services", { user: req.user || null }));
app.get("/contact", (req, res) => res.render("website/contact", { user: req.user || null }));

app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
    user: req.user || null,
  });
});

// ---------- SSE chat-stream (preserve existing behavior) ----------
app.post("/api/chat-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const keepAlive = setInterval(() => {
    try {
      res.write(":\n\n");
    } catch (e) {}
  }, 15000);

  try {
    const { entity } = req.body;
    if (!entity) {
      res.write("data: ❌ Missing entity name.\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    const systemPrompt = `You are the CRIPFCnt Audit Intelligence — trained under Donald Mataranyika’s model. Return a single structured SCOI audit.`;
    if (!openai || !openai.chat) {
      res.write("data: ❌ OpenAI not configured.\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Perform a full SCOI Audit for: "${entity}".` },
      ],
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        const lines = String(content).replace(/\r/g, "").split("\n");
        for (const line of lines) res.write(`data: ${line}\n`);
        res.write("\n");
      }
    }
  } catch (err) {
    console.error("chat-stream error:", err && err.stack ? err.stack : err);
    res.write(`data: ❌ Server error: ${String(err).replace(/\r?\n/g, " ")}\n\n`);
  } finally {
    clearInterval(keepAlive);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// ---------- static audits endpoint ----------
app.get("/api/audits", (req, res) => {
  res.json({
    framework: "CRIPFCnt SCOI Audit System",
    author: "Donald Mataranyika",
    data: [],
  });
});

// ---------- optional routes listing for localhost only (helpful debugging) ----------
app.get("/__routes", (req, res) => {
  const hostAllowed = req.ip === "127.0.0.1" || req.ip === "::1" || req.connection.remoteAddress === "127.0.0.1";
  if (!hostAllowed) return res.status(403).send("Forbidden");
  const routes = [];
  (app._router?.stack || []).forEach((layer) => {
    if (layer.route && layer.route.path) {
      const methods = Object.keys(layer.route.methods).join(",").toUpperCase();
      routes.push(`${methods} ${layer.route.path}`);
    } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
      // mounted router — find prefix (best-effort)
      layer.handle.stack.forEach((l) => {
        if (l.route && l.route.path) {
          const methods = Object.keys(l.route.methods).join(",").toUpperCase();
          // find mount path (best-effort from layer.regexp)
          const mount = layer.regexp && layer.regexp.source ? (layer.regexp.source.replace('^\\','/').split('\\/')[1] || '') : '';
          const prefix = mount ? `/${mount}` : "";
          routes.push(`${methods} ${prefix}${l.route.path}`);
        }
      });
    }
  });
  routes.sort();
  console.log("=== Mounted routes ===\n", routes.join("\n"));
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(routes.join("\n"));
});

// ---------- catch-all error handler ----------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500);
  if (req.headers.accept && req.headers.accept.indexOf("text/html") !== -1) {
    return res.send("<h1>Server error</h1><p>Check server logs</p>");
  }
  return res.json({ error: "Server error" });
});

// prevent silent death
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason && reason.stack ? reason.stack : reason);
});

// ---------- start ----------
const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
});
