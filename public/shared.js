export const MODELS = Object.freeze([
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" }
]);

export const DEFAULT_MODEL = MODELS[0].id;
export const MODES = ["chat", "work"];
export const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 4_000_000;

export function modelName(id) {
  return MODELS.find(model => model.id === id)?.name || id;
}

export function conversationContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === "model" && !message.text) continue;
    const parts = [];
    for (const file of message.files || []) {
      if (typeof file.text === "string") {
        parts.push({ text: "Fichier « " + file.name + " »\n" + file.text });
      } else {
        parts.push({ inlineData: { mimeType: file.mime, data: file.data } });
      }
    }
    if (message.text) parts.push({ text: message.text });
    if (!parts.length) continue;
    const previous = contents.at(-1);
    if (previous?.role === message.role) previous.parts.push(...parts);
    else contents.push({ role: message.role, parts });
  }
  return contents;
}
