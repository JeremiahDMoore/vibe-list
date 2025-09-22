// server.js
import express from "express";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import cors from "cors";

// Use Node's built-in fetch on Node 18+
// If you MUST support older Node, add: import fetch from "node-fetch";
import { GoogleGenAI } from "@google/genai"; // ✅ Correct SDK & symbol

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: "25mb" })); // allow larger base64 images
app.use(
  cors({
    origin: (origin, cb) => {
      // allow same-origin and local dev; harden for prod
      const allow = [undefined, "http://localhost:5173", "http://localhost:3000"];
      if (!origin || allow.includes(origin)) return cb(null, true);
      return cb(new Error("CORS: origin not allowed"));
      // Or simply: origin: true, credentials: true
    },
    credentials: true,
  })
);

// --- CONFIG ---
const cfg = {
  spotify: {
    auth: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI,
    scope: "playlist-modify-public playlist-modify-private ugc-image-upload", // ✅ correct for art upload
  },
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    scope: "https://www.googleapis.com/auth/youtube", // playlist mgmt; add others if needed
  },
};

// --- Gemini / Imagen setup (Google GenAI SDK) ---
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
if (!ai) {
  console.warn("Gemini API key not configured. AI features will be disabled.");
} else {
  console.log("Google GenAI SDK initialized.");
}

// Simple in-memory state; use Redis in prod
const txns = new Map();

// --------- AI Endpoints ---------

// 1) Turn an input image+mood into a TEXT prompt for an image generator
app.post("/generate-album-cover-prompt", async (req, res) => {
  if (!ai) return res.status(503).json({ error: "AI service not configured." });

  const { imageData, imageMimeType, mood, styles } = req.body || {};
  if (!imageData || !imageMimeType || !mood || !styles) {
    return res.status(400).json({ error: "Missing parameters." });
  }

  try {
    const imagePart = { inlineData: { data: imageData, mimeType: imageMimeType } };

    const styleBits = [];
    if (styles.decade?.length) styleBits.push(`decade aesthetic: ${styles.decade.join(", ")}`);
    if (styles.genre?.length) styleBits.push(`music genres: ${styles.genre.join(", ")}`);
    if (styles.style) styleBits.push(`art style: ${styles.style}`);
    const styleText = styleBits.length ? ` Incorporate: ${styleBits.join("; ")}.` : "";

    const prompt = [
      { text: `Analyze the photo and the mood "${mood}". Create ONE paragraph that can be pasted into an image model to produce a striking album cover.${styleText} No chit-chat; output only the prompt.` },
      imagePart,
    ];

    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    }); // returns GenerateContentResponse
    const generatedText = resp.text?.trim();
    if (!generatedText) throw new Error("Model returned no text.");
    return res.json({ prompt: generatedText });
  } catch (err) {
    console.error("Error generating album cover prompt:", err);
    return res.status(500).json({ error: "Error generating album cover prompt." });
  }
});

// 2) Edit a selfie into an album cover and return an IMAGE
// Use an image-capable model. For highest quality, use Imagen 3; for fast edits, try Gemini 2.5 Flash Image Preview.
app.post("/edit-selfie-into-album-cover", async (req, res) => {
  if (!ai) return res.status(503).json({ error: "AI service not configured." });

  const { imageData, imageMimeType, prompt } = req.body || {};
  if (!imageData || !imageMimeType || !prompt) {
    return res.status(400).json({ error: "Missing parameters." });
  }

  try {
    // Option A: Imagen 3 (text-to-image or edit via prompt; returns base64 bytes)
    const imgResp = await ai.models.generateImages({
      model: "imagen-3.0-generate-002", // quality-first image model
      prompt: `Transform this user's photo into a complete album cover. ${prompt} 
               Square 1:1 aspect, keep the user's face recognizable and well-integrated.`,
      // Provide the source image to guide composition/style:
      image: { imageBytes: imageData }, // base64 string
      config: {
        numberOfImages: 1,
        outputMimeType: imageMimeType || "image/jpeg",
      },
    });

    const img0 = imgResp?.generatedImages?.[0]?.image?.imageBytes;
    if (!img0) throw new Error("Image model did not return image bytes.");

    return res.json({
      imageData: img0, // base64
      mimeType: imageMimeType || "image/jpeg",
    });
  } catch (err) {
    console.error("Error editing selfie into album cover:", err);
    // Fallback: tell client it failed (often due to safety filters); frontend can let user tweak prompt.
    return res.status(500).json({
      error: `Error editing selfie into album cover: ${err.message}`,
    });
  }
});

// 3) JSON-safe “playlist vibe”
app.post("/generate-playlist-vibe", async (req, res) => {
  if (!ai) return res.status(503).json({ error: "AI service not configured." });

  const { mood, albumPrompt, playlistLength } = req.body || {};
  if (!mood || !albumPrompt || !playlistLength) {
    return res.status(400).json({ error: "Missing parameters." });
  }

  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          text: `Return ONLY JSON with keys:
          "vibe": string (1-2 sentences),
          "genre": string (primary genre),
          "songs": array of exactly ${playlistLength} objects with "title" and "artist" strings.
          Mood: "${mood}". Album cover: "${albumPrompt}".`,
        },
      ],
      // Ask for JSON output and be ready to parse/defence if fencing occurs.
      config: { responseMimeType: "application/json" },
    });

    let jsonText = resp.text?.trim() || "";
    // strip ``` fences if present
    const m = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (m) jsonText = m[1].trim();

    let data;
    try {
      data = JSON.parse(jsonText);
    } catch {
      // fallback: tell the client it failed in a controlled way
      return res.status(502).json({ error: "Model did not return valid JSON." });
    }
    return res.json(data);
  } catch (err) {
    console.error("Error generating playlist vibe:", err);
    return res.status(500).json({ error: "Error generating playlist vibe." });
  }
});

// --------- OAuth ---------

app.get("/oauth/start", (req, res) => {
  const { provider, redirect } = req.query;
  if (!["spotify", "google"].includes(provider)) return res.status(400).send("bad provider");
  if (!redirect || !/^https?:\/\/.+/i.test(redirect)) return res.status(400).send("bad redirect");

  const state = crypto.randomBytes(16).toString("hex");
  txns.set(state, { redirect });

  let authUrl;
  if (provider === "spotify") {
    const u = new URL(cfg.spotify.auth);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cfg.spotify.clientId);
    u.searchParams.set("redirect_uri", cfg.spotify.redirectUri);
    u.searchParams.set("scope", cfg.spotify.scope);
    u.searchParams.set("state", state);
    u.searchParams.set("show_dialog", "true");
    authUrl = u.toString();
  } else {
    const u = new URL(cfg.google.auth);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cfg.google.clientId);
    u.searchParams.set("redirect_uri", cfg.google.redirectUri);
    u.searchParams.set("scope", cfg.google.scope);
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("state", state);
    authUrl = u.toString();
  }
  return res.redirect(authUrl);
});

async function exchangeSpotify(code) {
  const r = await fetch(cfg.spotify.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${cfg.spotify.clientId}:${cfg.spotify.clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.spotify.redirectUri,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Spotify token exchange failed:", r.status, data);
    return { error: data.error_description || data.error || "Failed to exchange token with Spotify" };
  }
  return data; // includes access_token, refresh_token (if granted)
}

async function exchangeGoogle(code) {
  const r = await fetch(cfg.google.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: cfg.google.clientId,
      client_secret: cfg.google.clientSecret,
      redirect_uri: cfg.google.redirectUri,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Google token exchange failed:", r.status, data);
    return { error: data.error_description || data.error || "Failed to exchange token with Google" };
  }
  return data;
}

function finish(res, state, data, provider, isError = false) {
  const txn = txns.get(state);
  if (!txn) {
    return res.status(400).send(`
      <html><body>
        <h2>Error</h2>
        <p>Invalid state parameter. Close this window and try again.</p>
      </body></html>
    `);
  }
  txns.delete(state);

  const targetOrigin = new URL(txn.redirect).origin;
  const result = isError ? { provider, error: data.error || "Unknown error." } : { provider, token: data.access_token };

  res.send(`
    <html>
      <head><title>Authentication Complete</title></head>
      <body>
        <p>${isError ? `Authentication failed: ${result.error}` : "Authentication successful!"}</p>
        <script>
          try {
            if (window.opener) {
              window.opener.postMessage(${JSON.stringify(result)}, '${targetOrigin}');
            }
          } finally { window.close(); }
        </script>
      </body>
    </html>
  `);
}

// Callbacks
app.get("/callback/spotify", async (req, res) => {
  const { code, state, error } = req.query;
  if (!state) return res.status(400).send("Missing state from Spotify callback.");
  if (error) return finish(res, state, { error }, "spotify", true);
  if (!code) return finish(res, state, { error: "Missing code from Spotify callback." }, "spotify", true);

  const tokens = await exchangeSpotify(code);
  if (tokens.error || !tokens.access_token) return finish(res, state, { error: tokens.error }, "spotify", true);
  return finish(res, state, tokens, "spotify");
});

app.get("/callback/google", async (req, res) => {
  const { code, state, error } = req.query;
  if (!state) return res.status(400).send("Missing state from Google callback.");
  if (error) return finish(res, state, { error }, "google", true);
  if (!code) return finish(res, state, { error: "Missing code from Google callback." }, "google", true);

  const tokens = await exchangeGoogle(code);
  if (tokens.error || !tokens.access_token) return finish(res, state, { error: tokens.error }, "google", true);
  return finish(res, state, tokens, "google");
});

app.get("/", (_req, res) => res.send("OK"));

const port = process.env.PORT || 10000;
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Auth server listening on port ${port}`);
});

// Longer timeouts for some hosts (e.g., Render)
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 120 * 1000;
