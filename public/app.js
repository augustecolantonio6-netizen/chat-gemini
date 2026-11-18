import { MODELS, DEFAULT_MODEL, MODES, MAX_FILE_BYTES, MAX_REQUEST_BYTES, MEDIA_TYPES, conversationContents, modelName } from "./shared.js";
import { loadThreads, saveThread, removeThread, readSetting, writeSetting } from "./storage.js";
import { action, el, icon, markdown } from "./render.js";
import { readReply } from "./stream.js";

const $ = id => document.getElementById(id);
for (const placeholder of document.querySelectorAll("[data-i]")) placeholder.append(icon(placeholder.dataset.i));

const suggestions = {
  chat: [
    ["Explorer", "Comprendre un concept", "bulb", "violet", "Explique-moi un concept surprenant en mathématiques, avec un exemple simple."],
    ["Écrire", "Trouver les bons mots", "pen", "peach", "Aide-moi à rédiger un texte. Commence par me demander à qui il s’adresse et quel ton je veux lui donner."],
    ["Coder", "Construire un projet", "code", "blue", "Propose-moi trois idées de petits projets de code à réaliser en un week-end."]
  ],
  work: [
    ["Planifier", "Découper un projet", "work", "violet", "Aide-moi à découper mon projet en étapes concrètes. Commence par me demander mon objectif et le temps disponible."],
    ["Rédiger", "Préparer un plan", "pen", "peach", "Aide-moi à construire un plan de rédaction. Demande-moi d’abord le sujet et les consignes."],
    ["Déboguer", "Examiner du code", "code", "blue", "Aide-moi à déboguer mon programme. Je vais te donner le code, l’erreur et le comportement attendu."]
  ]
};

const threads = new Map();
const drafts = new Map();
const jobs = new Map();
const deleted = new Set();
const mobile = matchMedia("(max-width: 800px)");
let compact = readSetting("localStorage", "compact") === "1";
let key = readSetting("sessionStorage", "api-key") || readSetting("localStorage", "api-key");
let remembered = Boolean(key && key === readSetting("localStorage", "api-key"));
let active;
let afterKey = null;
let removeTarget = null;
let speech = null;
let toastTimer;
let storageWarning = false;
let drawFrame = 0;

function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4200);
}

function warnStorage() {
  if (storageWarning) return;
  storageWarning = true;
  toast("Le navigateur ne peut pas enregistrer l’historique. La discussion reste accessible dans cet onglet.");
}

function persist(thread) {
  if (!deleted.has(thread.id)) saveThread(thread).catch(warnStorage);
}

function newThread() {
  const lastModel = readSetting("localStorage", "model");
  return {
    id: crypto.randomUUID(), title: "", updated: Date.now(), messages: [],
    model: MODELS.some(model => model.id === lastModel) ? lastModel : DEFAULT_MODEL,
    mode: readSetting("localStorage", "mode") === "work" ? "work" : "chat"
  };
}

function draftFor(id = active.id) {
  if (!drafts.has(id)) drafts.set(id, { text: "", files: [], loading: false });
  return drafts.get(id);
}

function setSidebar(open = false) {
  const isMobile = mobile.matches;
  $("workspace").classList.toggle("sidebar-mini", !isMobile && compact);
  $("workspace").classList.toggle("nav-open", isMobile && open);
  $("sidebar").inert = isMobile && !open;
  $("main").inert = isMobile && open;
  $("scrim").hidden = !(isMobile && open);
  $("expand").setAttribute("aria-expanded", String(isMobile ? open : !compact));
}

function chooseThread(thread) {
  if (speech) speech.abort();
  closeMenu(false);
  if (active && !active.messages.length && !draftFor().text && !draftFor().files.length && !draftFor().loading) drafts.delete(active.id);
  active = thread;
  writeSetting("sessionStorage", "active", thread.messages.length ? thread.id : "");
  setSidebar();
  $("prompt").value = draftFor().text;
  renderView();
  requestAnimationFrame(scrollBottom);
}

function startNew() {
  chooseThread(newThread());
  if (!mobile.matches) $("prompt").focus();
}

function sortedThreads() {
  return [...threads.values()].sort((a, b) => b.updated - a.updated);
}

function showHistory() {
  const list = $("history-list");
  list.replaceChildren();
  const sorted = sortedThreads();
  $("history-empty").hidden = sorted.length > 0;
  for (const thread of sorted) {
    const row = el("div", "history-row");
    row.classList.toggle("active", thread.id === active.id);
    const open = el("button", "history-open");
    open.type = "button";
    open.title = thread.title;
    if (thread.id === active.id) open.setAttribute("aria-current", "true");
    open.append(icon("chat"), el("span", "", thread.title));
    open.onclick = () => chooseThread(thread);
    const remove = action("icon-button delete-chat", "Supprimer « " + thread.title + " »", "trash", () => {
      removeTarget = thread;
      $("delete-name").textContent = "« " + thread.title + " » sera effacée de cet appareil.";
      $("delete-dialog").showModal();
      $("delete-dialog").querySelector("[data-close]").focus();
    });
    row.append(open, remove);
    list.append(row);
  }
}

function renderSuggestions() {
  const area = $("suggestions");
  area.replaceChildren();
  for (const [title, detail, symbol, tone, prompt] of suggestions[active.mode]) {
    const button = el("button", "suggestion");
    button.type = "button";
    const badge = el("span", "suggest-icon tone-" + tone);
    badge.append(icon(symbol));
    const text = el("span", "suggest-text");
    text.append(el("strong", "", title), el("small", "", detail));
    button.append(badge, text, icon("up-right", "suggest-arrow"));
    button.onclick = () => {
      draftFor().text = prompt;
      $("prompt").value = prompt;
      updateComposer();
      $("prompt").focus();
      $("prompt").setSelectionRange(prompt.length, prompt.length);
    };
    area.append(button);
  }
}

function renderModes() {
  for (const mode of MODES) $("mode-" + mode).setAttribute("aria-pressed", String(active.mode === mode));
  $("greeting-title").replaceChildren(active.mode === "work" ? "Au travail, " : "Bonjour ", el("span", "", "Auguste."));
  $("greeting-sub").textContent = active.mode === "work" ? "Sur quoi travaille-t-on aujourd’hui\u00a0?" : "Par où commence-t-on aujourd’hui\u00a0?";
  $("prompt").placeholder = active.mode === "work" ? "Décris ta tâche à Chat Gemini…" : "Écris un message à Chat Gemini…";
  renderSuggestions();
}

function renderView() {
  const hasMessages = active.messages.length > 0;
  $("workspace").classList.toggle("is-thread", hasMessages);
  $("greeting").hidden = hasMessages;
  $("suggestions").hidden = hasMessages;
  $("thread-scroll").hidden = !hasMessages;
  document.title = hasMessages ? active.title + " · Chat Gemini" : "Chat Gemini";
  $("model-name").textContent = modelName(active.model);
  renderModes();
  showHistory();
  renderMessages();
  renderFiles();
  updateComposer();
}

function nearBottom() {
  const box = $("thread-scroll");
  return box.scrollHeight - box.clientHeight - box.scrollTop < 95;
}
function scrollBottom() { $("thread-scroll").scrollTop = $("thread-scroll").scrollHeight; }

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Réponse copiée.");
  } catch { toast("La copie est indisponible. Tu peux sélectionner le texte de la réponse."); }
}

function messageNode(message, last) {
  if (message.role === "user") {
    const article = el("article", "user-message");
    article.setAttribute("aria-label", "Toi");
    for (const file of message.files || []) {
      const chip = el("div", "user-file");
      chip.append(icon("file"), el("span", "", file.name)); article.append(chip);
    }
    if (message.text) article.append(el("div", "user-bubble", message.text));
    return article;
  }

  const article = el("article", "bot-message");
  article.id = "m-" + message.id;
  const head = el("div", "bot-head");
  const badge = el("span", "bot-avatar"); badge.append(icon("spark"));
  head.append(badge, el("strong", "", "Chat Gemini"), el("span", "bot-model", modelName(message.model)));
  article.append(head);
  const prose = el("div", "prose");
  if (message.status === "pending") {
    prose.classList.add("streaming");
    if (message.text) prose.textContent = message.text;
    else {
      const dots = el("span", "thinking"); dots.setAttribute("aria-label", "Génération en cours");
      dots.append(el("i"), el("i"), el("i")); prose.append(dots);
    }
  } else if (message.text) prose.append(markdown(message.text));
  article.append(prose);
  if (message.note) {
    const note = el("div", "note");
    note.setAttribute("role", "status");
    note.append(icon("warning"), el("span", "", message.note));
    article.append(note);
  }
  if (message.status !== "pending") {
    const tools = el("div", "reply-tools");
    if (message.text) tools.append(action("", "Copier la réponse", "copy", () => copyText(message.text)));
    if (last && message.note) {
      const retry = action("", "Réessayer avec le modèle sélectionné", "retry", () => sendMessage(true));
      retry.append("Réessayer"); tools.append(retry);
    }
    if (tools.childElementCount) article.append(tools);
  }
  return article;
}

function renderMessages() {
  $("messages").replaceChildren(...active.messages.map((message, index) => messageNode(message, index === active.messages.length - 1)));
}

function updateStream(thread, message) {
  if (active !== thread || drawFrame) return;
  drawFrame = requestAnimationFrame(() => {
    drawFrame = 0;
    if (active !== thread || message.status !== "pending") return;
    const node = $("m-" + message.id)?.querySelector(".prose");
    if (node) {
      const follow = nearBottom();
      node.textContent = message.text;
      if (follow) scrollBottom();
    }
  });
}

function updateComposer() {
  const input = $("prompt");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, Math.min(innerHeight * .27, 175)) + "px";
  const running = jobs.has(active.id);
  const draft = draftFor();
  const send = $("send");
  send.disabled = !running && (draft.loading || !(draft.text.trim() || draft.files.length));
  const label = running ? "Arrêter la réponse" : "Envoyer";
  if (send.getAttribute("aria-label") !== label) {
    send.setAttribute("aria-label", label); send.title = label;
    send.replaceChildren(icon(running ? "stop" : "up"));
  }
  $("attach").disabled = draft.loading;
}

function renderFiles() {
  const { files } = draftFor();
  const area = $("pending-files"); area.replaceChildren(); area.hidden = !files.length;
  for (const file of files) {
    const chip = el("span", "file-pill"); chip.title = file.name;
    chip.append(icon("file"), el("span", "", file.name), action("", "Retirer " + file.name, "x", () => {
      const draft = draftFor(); draft.files = draft.files.filter(item => item !== file);
      renderFiles(); updateComposer();
    }));
    area.append(chip);
  }
}

function binaryFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Impossible de lire « " + file.name + " »."));
    reader.readAsDataURL(file);
  });
}

async function attachFiles(list) {
  const thread = active;
  const draft = draftFor();
  if (draft.loading) return;
  draft.loading = true; updateComposer();
  const issues = [];
  for (const file of list) {
    try {
      if (!file.size || file.size > MAX_FILE_BYTES) throw new Error("« " + file.name + " » doit peser entre 1 octet et 2 Mio.");
      const ext = file.name.split(".").pop().toLowerCase();
      const guess = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", pdf: "application/pdf" };
      const mime = file.type || guess[ext];
      if (["txt", "md"].includes(ext) || ["text/plain", "text/markdown"].includes(mime)) {
        draft.files.push({ name: file.name, text: await file.text() });
      } else if (MEDIA_TYPES.includes(mime)) {
        draft.files.push({ name: file.name, mime, data: await binaryFile(file) });
      } else throw new Error("Formats acceptés : PNG, JPEG, WebP, PDF, TXT et Markdown.");
    } catch (error) { issues.push(error.message); }
  }
  draft.loading = false;
  if (active === thread) { renderFiles(); updateComposer(); }
  if (issues.length) toast(issues.join(" "));
}

function openSettings(continuation = null) {
  closeMenu(false); setSidebar();
  afterKey = continuation;
  $("api-key").type = "password"; $("api-key").value = key;
  $("show-key").replaceChildren(icon("eye"));
  $("show-key").setAttribute("aria-label", "Afficher la clé"); $("show-key").title = "Afficher la clé";
  $("remember-key").checked = remembered; $("forget-key").hidden = !key;
  $("settings-error").hidden = true;
  $("settings-dialog").showModal(); $("api-key").focus();
}

function updateKeyButton() {
  $("key-dot").classList.toggle("connected", Boolean(key));
  const label = key ? "Clé API renseignée · Paramètres" : "Configurer la clé API";
  $("key-button").title = label; $("key-button").setAttribute("aria-label", label);
}

function saveSettings(event) {
  event.preventDefault();
  const value = $("api-key").value.trim();
  if (!value || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    $("settings-error").textContent = "Vérifie que tu as collé une clé complète, sans espaces.";
    $("settings-error").hidden = false; $("api-key").focus(); return;
  }
  key = value; remembered = $("remember-key").checked;
  writeSetting(remembered ? "sessionStorage" : "localStorage", "api-key", "");
  const stored = writeSetting(remembered ? "localStorage" : "sessionStorage", "api-key", key);
  const resume = afterKey; afterKey = null;
  $("settings-dialog").close(); updateKeyButton();
  toast(stored ? "Clé API enregistrée." : "Clé utilisable sur cette page. Le navigateur a refusé sa mémorisation.");
  if (resume) resume();
}

async function sendMessage(retry = false) {
  const thread = active;
  const draft = draftFor();
  if (jobs.has(thread.id) || draft.loading || (!retry && !(draft.text.trim() || draft.files.length))) return;
  const last = thread.messages.at(-1);
  if (retry && (last?.role !== "model" || !last.note)) return;
  if (!key) { openSettings(() => { if (active === thread) sendMessage(retry); }); return; }

  const user = retry ? null : { id: crypto.randomUUID(), role: "user", text: draft.text.trim(), files: [...draft.files] };
  const history = retry ? thread.messages.slice(0, -1) : [...thread.messages, user];
  const body = JSON.stringify({ model: thread.model, mode: thread.mode, contents: conversationContents(history) });
  if (new Blob([body]).size > MAX_REQUEST_BYTES) {
    toast("La discussion dépasse la taille d’un envoi. Retire un fichier ou ouvre une nouvelle discussion."); return;
  }

  const answer = { id: crypto.randomUUID(), role: "model", model: thread.model, text: "", status: "pending", note: "" };
  thread.messages = [...history, answer]; thread.updated = Date.now();
  if (!thread.title) {
    const title = (user?.text || user?.files[0]?.name || "Discussion").split("\n")[0].trim();
    const firstSentence = title.match(/^.{6,}?[.!?](?=\s|$)/u)?.[0] || title;
    const short = firstSentence.slice(0, 67).replace(/\s+\S*$/u, "").trim();
    thread.title = firstSentence.length <= 70 ? firstSentence : (short || firstSentence.slice(0, 67)) + "…";
  }
  threads.set(thread.id, thread);
  writeSetting("sessionStorage", "active", thread.id);
  if (!retry) {
    draft.text = ""; draft.files = []; $("prompt").value = "";
  }
  if (speech) speech.abort();
  const controller = new AbortController();
  jobs.set(thread.id, controller);
  persist(thread); closeMenu(false); renderView(); scrollBottom();

  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", "x-gemini-key": key },
      cache: "no-store", body, signal: controller.signal
    });
    if (!response.ok) {
      const information = await response.json().catch(() => null);
      const fallback = response.status === 413 ? "Cet envoi dépasse la limite du serveur. Ouvre une nouvelle discussion ou retire un fichier." : "Le serveur a renvoyé une erreur (" + response.status + "). Réessaie dans un instant.";
      throw new Error(typeof information?.error === "string" ? information.error : fallback);
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Le serveur de chat n’a pas renvoyé de flux de réponse.");
    answer.note = await readReply(response.body, text => { answer.text += text; updateStream(thread, answer); });
    answer.status = "done";
  } catch (error) {
    answer.status = "interrupted";
    answer.note = controller.signal.aborted ? "Génération arrêtée." : error instanceof TypeError ? "Connexion interrompue. Vérifie ta connexion et réessaie." : error.message;
  } finally {
    jobs.delete(thread.id);
    if (!deleted.has(thread.id)) {
      persist(thread);
      if (active === thread) {
        const follow = nearBottom(); renderMessages(); updateComposer();
        if (follow) scrollBottom();
      }
    }
  }
}

function closeMenu(focus = true) {
  if ($("model-menu").hidden) return;
  $("model-menu").hidden = true; $("model-toggle").setAttribute("aria-expanded", "false");
  if (focus) $("model-toggle").focus();
}

function positionMenu() {
  const menu = $("model-menu"); if (menu.hidden) return;
  const rect = $("model-toggle").getBoundingClientRect();
  const vh = document.documentElement.clientHeight;
  const below = vh - rect.bottom - 13;
  const above = rect.top - 13;
  const down = below >= menu.scrollHeight || below > above;
  menu.style.maxHeight = Math.max(90, down ? below : above) + "px";
  const left = Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8));
  menu.style.left = left + "px";
  menu.style.top = (down ? rect.bottom + 5 : Math.max(5, rect.top - menu.offsetHeight - 5)) + "px";
}

function showMenu() {
  if (!$("model-menu").hidden) { closeMenu(); return; }
  const list = $("model-options"); list.replaceChildren();
  for (const model of MODELS) {
    const button = el("button", "model-option"); button.type = "button";
    const checked = model.id === active.model;
    button.setAttribute("role", "menuitemradio"); button.setAttribute("aria-checked", String(checked));
    const text = el("span"); text.append(el("strong", "", model.name), el("small", "", model.id));
    button.append(icon("spark", "model-spark"), text);
    if (checked) button.append(icon("check", "model-check"));
    button.onclick = () => {
      active.model = model.id;
      writeSetting("localStorage", "model", model.id);
      if (active.messages.length) persist(active);
      $("model-name").textContent = model.name; closeMenu();
    };
    list.append(button);
  }
  $("model-menu").hidden = false; $("model-toggle").setAttribute("aria-expanded", "true"); positionMenu();
  list.querySelector('[aria-checked="true"]').focus({ preventScroll: true });
}

function normalized(value) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function searchResults() {
  const area = $("search-results"); area.replaceChildren();
  const query = normalized($("search-input").value.trim());
  for (const thread of sortedThreads()) {
    const match = query && thread.messages.find(m => normalized(m.text).includes(query));
    if (query && !normalized(thread.title).includes(query) && !match) continue;
    const button = el("button", "result"); button.type = "button";
    const labels = el("span", "result-text");
    const snippet = match?.text || thread.messages.find(m => m.role === "model" && m.text)?.text || "";
    labels.append(el("strong", "", thread.title));
    if (snippet) labels.append(el("small", "", snippet.slice(0, 140)));
    button.append(icon("chat"), labels);
    button.onclick = () => { $("search-dialog").close(); chooseThread(thread); };
    area.append(button);
  }
  if (!area.childElementCount) area.append(el("p", "empty-results", query ? "Aucune discussion ne correspond à ta recherche." : "Tes discussions apparaîtront ici après ton premier message."));
}

function openSearch() {
  setSidebar(); closeMenu(false); $("search-input").value = ""; searchResults();
  $("search-dialog").showModal(); $("search-input").focus();
}

function initSpeech() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return;
  const mic = $("microphone"); mic.hidden = false;
  mic.onclick = () => {
    if (speech) { speech.stop(); return; }
    const thread = active;
    const recognition = new Recognition();
    speech = recognition; recognition.lang = "fr-FR";
    recognition.onresult = event => {
      if (active !== thread || speech !== recognition) return;
      const draft = draftFor(); const text = event.results[0][0].transcript;
      draft.text = [draft.text.trimEnd(), text].filter(Boolean).join(" ");
      $("prompt").value = draft.text; updateComposer();
    };
    recognition.onend = () => {
      if (speech !== recognition) return;
      speech = null; mic.classList.remove("is-listening"); mic.title = "Dicter un message"; mic.setAttribute("aria-label", mic.title);
    };
    recognition.onerror = event => { if (event.error !== "aborted") toast(event.error === "not-allowed" ? "Autorise le microphone dans ton navigateur pour dicter un message." : "La dictée est indisponible dans ce navigateur."); };
    try {
      recognition.start(); mic.classList.add("is-listening"); mic.title = "Arrêter la dictée"; mic.setAttribute("aria-label", mic.title);
    } catch { recognition.onend(); toast("La dictée est indisponible."); }
  };
}

function bindEvents() {
  $("new-chat").onclick = startNew; $("brand").onclick = startNew;
  $("search").onclick = openSearch;
  $("collapse").onclick = () => {
    if (!mobile.matches) { compact = true; writeSetting("localStorage", "compact", "1"); }
    setSidebar(); $("expand").focus();
  };
  $("expand").onclick = () => {
    if (mobile.matches) { setSidebar(true); $("new-chat").focus(); }
    else { compact = false; writeSetting("localStorage", "compact", ""); setSidebar(); $("collapse").focus(); }
  };
  $("scrim").onclick = () => { setSidebar(); $("expand").focus(); };
  mobile.addEventListener("change", () => setSidebar());
  for (const mode of MODES) $("mode-" + mode).onclick = () => {
    active.mode = mode; writeSetting("localStorage", "mode", mode);
    if (active.messages.length) persist(active);
    renderModes();
  };
  $("key-button").onclick = $("settings").onclick = () => openSettings();
  $("settings-form").onsubmit = saveSettings;
  $("settings-dialog").addEventListener("close", () => { afterKey = null; $("api-key").value = ""; });
  $("show-key").onclick = () => {
    const show = $("api-key").type === "password";
    $("api-key").type = show ? "text" : "password";
    $("show-key").replaceChildren(icon(show ? "eye-off" : "eye"));
    const label = show ? "Masquer la clé" : "Afficher la clé"; $("show-key").title = label; $("show-key").setAttribute("aria-label", label);
  };
  $("forget-key").onclick = () => {
    key = ""; remembered = false; afterKey = null;
    for (const area of ["sessionStorage", "localStorage"]) writeSetting(area, "api-key", "");
    $("settings-dialog").close(); updateKeyButton(); toast("Clé API oubliée.");
  };
  for (const button of document.querySelectorAll("[data-close]")) button.onclick = () => button.closest("dialog").close();
  for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  $("search-input").oninput = searchResults;
  $("delete-confirm").onclick = () => {
    if (!removeTarget) return;
    const id = removeTarget.id; removeTarget = null;
    deleted.add(id); jobs.get(id)?.abort(); threads.delete(id); drafts.delete(id);
    $("delete-dialog").close();
    if (active.id === id) startNew(); else showHistory();
    removeThread(id).then(() => toast("Discussion supprimée."), () => toast("La suppression de l’historique sur l’appareil a échoué."));
  };
  $("delete-dialog").addEventListener("close", () => { removeTarget = null; });
  $("model-toggle").onclick = showMenu;
  $("model-toggle").onkeydown = event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); showMenu(); } };
  $("model-menu").onkeydown = event => {
    const items = [...$("model-options").children]; const index = items.indexOf(document.activeElement);
    const moves = { ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1 };
    if (event.key in moves) { event.preventDefault(); items[moves[event.key]].focus(); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); }
    if (event.key === "Tab") closeMenu();
  };
  document.addEventListener("pointerdown", event => { if (!event.target.closest("#model-menu,#model-toggle")) closeMenu(false); });
  window.addEventListener("resize", positionMenu);
  window.addEventListener("scroll", positionMenu, true);
  $("attach").onclick = () => $("file-input").click();
  $("file-input").onchange = () => { const files = [...$("file-input").files]; $("file-input").value = ""; attachFiles(files); };
  $("prompt").oninput = () => { draftFor().text = $("prompt").value; updateComposer(); };
  $("prompt").onkeydown = event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); if (!jobs.has(active.id)) sendMessage();
    }
  };
  $("composer").onsubmit = event => {
    event.preventDefault();
    const job = jobs.get(active.id);
    if (job) job.abort(); else sendMessage();
  };
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) {
      event.preventDefault(); openSearch();
    }
    if (event.key === "Escape" && $("workspace").classList.contains("nav-open")) { setSidebar(); $("expand").focus(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) for (const id of jobs.keys()) { const thread = threads.get(id); if (thread) persist(thread); }
  });
  initSpeech();
}

async function init() {
  try {
    for (const thread of await loadThreads()) {
      if (!Array.isArray(thread.messages) || !thread.messages.length) continue;
      for (const message of thread.messages) if (message.status === "pending") {
        message.status = "interrupted"; message.note = "La page a été fermée avant la fin de la réponse.";
      }
      threads.set(thread.id, thread);
    }
  } catch { warnStorage(); }
  active = threads.get(readSetting("sessionStorage", "active")) || newThread();
  if (/Mac|iPad|iPhone/.test(navigator.platform)) $("keyhint").textContent = "⌘ K";
  setSidebar(); updateKeyButton(); renderView(); bindEvents(); requestAnimationFrame(scrollBottom);
}
init();
