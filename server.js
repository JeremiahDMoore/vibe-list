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
      // Ask for JSON output and be ready to parse/defence if fencing o
