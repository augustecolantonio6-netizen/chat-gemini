async function* eventData(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let data = [];
  let ended = false;
  const takeLine = line => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    if (!line && data.length) {
      const payload = data.join("\n");
      data = [];
      return payload;
    }
  };
  try {
    while (!ended) {
      const { value, done } = await reader.read();
      ended = done;
      if (value) buffer += value;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const payload = takeLine(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (payload !== undefined) yield payload;
      }
    }
    if (buffer) takeLine(buffer);
    if (data.length) yield data.join("\n");
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readReply(body, onText) {
  let received = false;
  let finish = "";
  for await (const payload of eventData(body)) {
    if (payload === "[DONE]") break;
    let event;
    try { event = JSON.parse(payload); } catch { throw new Error("Le flux de réponse est illisible. Tu peux réessayer."); }
    if (event.error) throw new Error("Gemini a interrompu la réponse. Tu peux réessayer.");
    if (event.promptFeedback?.blockReason) throw new Error("Gemini a bloqué cette demande. Tu peux reformuler ton message.");
    const candidate = event.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      if (!part.thought && typeof part.text === "string" && part.text) {
        received = true;
        onText(part.text);
      }
    }
    if (candidate?.finishReason && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED") finish = candidate.finishReason;
  }
  if (!finish) throw new Error("La connexion s’est interrompue avant la fin de la réponse.");
  if (finish === "MAX_TOKENS") return "La réponse a atteint la limite de longueur du modèle.";
  if (finish !== "STOP") throw new Error("Gemini a interrompu la génération (" + finish + "). Tu peux reformuler ton message.");
  if (!received) throw new Error("Le modèle a terminé sans renvoyer de texte. Tu peux réessayer.");
  return "";
}
