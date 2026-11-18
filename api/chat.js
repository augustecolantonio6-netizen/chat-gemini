import { MAX_REQUEST_BYTES, MEDIA_TYPES, MODELS, MODES } from "../public/shared.js";

const googleBase = "https://generativelanguage.googleapis.com/v1beta/models/";
const noStore = { "Cache-Control": "private, no-store, no-transform" };
const instructions = {
  chat: "Tu es Chat Gemini, l’assistant de cet espace personnel. Réponds dans la langue de l’utilisateur, naturellement et clairement. Si cela aide, utilise du Markdown.",
  work: "Tu es Chat Gemini en mode Work. Aide à mener la tâche jusqu’à un résultat utilisable. Si le travail est complexe, structure les étapes et explicite les hypothèses utiles. Pour une tâche simple, réponds directement. Réponds dans la langue de l’utilisateur. Utilise du Markdown lorsque cela aide."
};

function failure(status, error, extra = {}) {
  return Response.json({ error }, { status, headers: { ...noStore, ...extra } });
}

function validPart(part) {
  if (!part || typeof part !== "object") return false;
  if (typeof part.text === "string") return Object.keys(part).length === 1 && part.text.length > 0;
  const blob = part.inlineData;
  return Object.keys(part).length === 1 && blob && Object.keys(blob).length === 2 &&
    MEDIA_TYPES.includes(blob.mimeType) && typeof blob.data === "string" &&
    blob.data.length > 0 && blob.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(blob.data);
}

function validContents(contents) {
  return Array.isArray(contents) && contents.length > 0 && contents.at(-1)?.role === "user" &&
    contents.every((turn, index) => turn?.role === (index % 2 ? "model" : "user") &&
      Array.isArray(turn.parts) && turn.parts.length > 0 && turn.parts.every(validPart));
}

function googleError(status, detail, model) {
  const reasons = detail?.error?.details;
  if (status === 401 || (Array.isArray(reasons) && reasons.some(item => /API_KEY/.test(item?.reason || ""))) ||
      /api key not valid|api key expired|invalid api key/i.test(detail?.error?.message || "")) {
    return "Google refuse cette clé API. Vérifie-la dans les paramètres, puis réessaie.";
  }
  if (status === 404) return "Le modèle " + model + " est indisponible avec cette clé. Choisis un autre modèle et réessaie.";
  if (status === 403) return "Google refuse l’accès. Vérifie les restrictions de ta clé et son accès au modèle sélectionné.";
  if (status === 429) return "Le quota ou la limite de débit de ta clé est atteint. Réessaie plus tard ou choisis un autre modèle.";
  if (status === 400 || status === 413) return "Google refuse ce message. Vérifie les pièces jointes ou essaie avec une discussion plus courte.";
  return "Le service Gemini est momentanément indisponible. Réessaie dans un instant.";
}

async function handleChat(request) {
  const key = request.headers.get("x-gemini-key")?.trim();
  if (!key || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) return failure(401, "Ajoute ta clé API Gemini dans les paramètres.");
  if (!request.headers.get("content-type")?.includes("application/json")) return failure(415, "Un message JSON est attendu.");
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) return failure(413, "Cette discussion est trop volumineuse. Ouvre une nouvelle discussion ou retire un fichier.");

  let input;
  try {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_REQUEST_BYTES) return failure(413, "Cette discussion est trop volumineuse. Ouvre une nouvelle discussion ou retire un fichier.");
    input = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return failure(400, "Le message est illisible.");
  }
  if (!input || !MODELS.some(model => model.id === input.model) || !MODES.includes(input.mode)) {
    return failure(400, "Ce modèle ou ce mode est inconnu.");
  }
  if (!validContents(input.contents)) return failure(400, "Le format de la conversation est invalide.");
  const endpoint = googleBase + input.model + ":streamGenerateContent?alt=sse";
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key, "x-goog-api-client": "chat-gemini/1.0" },
      signal: request.signal,
      body: JSON.stringify({
        contents: input.contents,
        systemInstruction: { parts: [{ text: instructions[input.mode] }] }
      })
    });
    if (!upstream.ok) {
      const detail = await upstream.json().catch(() => null);
      return failure(upstream.status, googleError(upstream.status, detail, input.model));
    }
    if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
      return failure(502, "Google a renvoyé une réponse inattendue. Réessaie dans un instant.");
    }
    return new Response(upstream.body, { headers: { ...noStore, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
  } catch {
    return failure(502, "Impossible de joindre Gemini. Vérifie la connexion et réessaie.");
  }
}

export default {
  fetch(request) {
    if (request.method !== "POST") return failure(405, "Utilise la méthode POST.", { Allow: "POST" });
    return handleChat(request);
  }
};
