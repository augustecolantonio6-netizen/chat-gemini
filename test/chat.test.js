import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/chat.js";
import { readReply } from "../public/stream.js";
import { MODELS, conversationContents } from "../public/shared.js";

const text = value => ({ text: value });
const turn = value => ({ role: "user", parts: [text(value)] });
const dataEvent = obj => "data: " + JSON.stringify(obj) + "\r\n\r\n";
const candidate = (parts, finishReason) => ({ candidates: [{ content: { parts }, finishReason }] });
function request(options = {}, headers = { "x-gemini-key": "cle-fictive" }) {
  return new Request("http://localhost/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "gemini-3.8-flash", mode: "chat", contents: [turn("Bonjour")], ...options })
  });
}
function fragmented(string) {
  const bytes = new TextEncoder().encode(string);
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } });
}

test("streaming UTF-8 fragmenté, commentaires SSE, texte visible et dernier événement sans saut de ligne", async () => {
  const events = ": keepalive\r\n\r\n" + dataEvent(candidate([{ text: "interne", thought: true }, text("Été ")])) +
    dataEvent(candidate([text("☀️")], "STOP")).trimEnd();
  let output = "";
  assert.equal(await readReply(fragmented(events), delta => { output += delta; }), "");
  assert.equal(output, "Été ☀️");
});

test("un flux incomplet ou bloqué ne devient pas une réponse réussie", async () => {
  await assert.rejects(readReply(fragmented(dataEvent(candidate([text("début")]))), () => {}), /interrompue/);
  await assert.rejects(readReply(fragmented(dataEvent({ promptFeedback: { blockReason: "SAFETY" } })), () => {}), /bloqué/);
  await assert.rejects(readReply(fragmented(dataEvent(candidate([], "STOP"))), () => {}), /sans renvoyer/);
  assert.match(await readReply(fragmented(dataEvent(candidate([text("début")], "MAX_TOKENS"))), () => {}), /longueur/);
});

test("le contexte garde les fichiers et les rôles après une réponse en échec", () => {
  const photo = { name: "photo.png", mime: "image/png", data: "YQ==" };
  const history = [
    { role: "user", files: [photo], text: "Décris." }, { role: "model", text: "" },
    { role: "user", text: "En français." }, { role: "model", text: "Voici." },
    { role: "user", text: "Et ce fichier ?", files: [{ name: "suite.txt", text: "la suite" }] }
  ];
  assert.deepEqual(conversationContents(history), [
    { role: "user", parts: [{ inlineData: { mimeType: photo.mime, data: photo.data } }, text("Décris."), text("En français.")] },
    { role: "model", parts: [text("Voici.")] },
    { role: "user", parts: [text("Fichier « suite.txt »\nla suite"), text("Et ce fichier ?")] }
  ]);
});

test("les cinq identifiants, la clé et le contexte parviennent à la route Google choisie", async t => {
  const ids = ["gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite", "gemini-3.7-flash", "gemini-3.8-flash"];
  assert.deepEqual(MODELS.map(model => model.id).sort(), [...ids].sort());
  const contents = [turn("Un"), { role: "model", parts: [text("Deux")] }, turn("Trois")];
  const spy = t.mock.method(globalThis, "fetch", async () => new Response(dataEvent(candidate([text("réponse")], "STOP")), {
    headers: { "Content-Type": "text/event-stream" }
  }));
  for (const model of ids) {
    const response = await handler.fetch(request({ model, mode: "work", contents }));
    assert.equal(response.status, 200);
    const [url, options] = spy.mock.calls.at(-1).arguments;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse");
    assert.equal(options.headers["x-goog-api-key"], "cle-fictive");
    assert.deepEqual(JSON.parse(options.body).contents, contents);
    assert.match(JSON.parse(options.body).systemInstruction.parts[0].text, /mode Work/);
    assert.ok(!options.body.includes("cle-fictive"));
    assert.match(response.headers.get("Cache-Control"), /no-store/);
    let result = ""; await readReply(response.body, delta => { result += delta; });
    assert.equal(result, "réponse");
  }
});

test("clé manquante, modèle inconnu, historique invalide et corps trop gros sont rejetés localement", async t => {
  const spy = t.mock.method(globalThis, "fetch", () => assert.fail("appel Google inattendu"));
  assert.equal((await handler.fetch(new Request("http://localhost/api/chat"))).status, 405);
  assert.equal((await handler.fetch(request({}, {}))).status, 401);
  assert.equal((await handler.fetch(request({ model: "autre" }))).status, 400);
  assert.equal((await handler.fetch(request({ contents: [{ role: "user", parts: [{ fileData: {} }] }] }))).status, 400);
  assert.equal((await handler.fetch(request({ contents: [turn("long".repeat(1_000_050))] }))).status, 413);
  assert.equal(spy.mock.callCount(), 0);
});

test("modèle indisponible, clé refusée et quota épuisé restent identifiables sans révéler la clé", async t => {
  for (const [status, detail, expected] of [[404, {}, /indisponible/], [429, {}, /quota/], [400, { error: { message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] } }, /clé API/]]) {
    const spy = t.mock.method(globalThis, "fetch", async () => Response.json(detail, { status }));
    const response = await handler.fetch(request()); const error = await response.json();
    assert.equal(response.status, status); assert.match(error.error, expected);
    assert.ok(!JSON.stringify(error).includes("cle-fictive"));
    assert.equal(spy.mock.callCount(), 1); spy.mock.restore();
  }
});
