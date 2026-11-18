const prefix = "chat-gemini.";
let database;

function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("chat-gemini", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("threads", { keyPath: "id" });
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Stockage occupé par un autre onglet."));
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
  });
  return database;
}

async function access(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("threads", mode);
    const request = action(transaction.objectStore("threads"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error("Écriture interrompue."));
    transaction.onerror = () => reject(transaction.error);
  });
}

export const loadThreads = () => access("readonly", store => store.getAll());
export const saveThread = thread => access("readwrite", store => store.put(thread));
export const removeThread = id => access("readwrite", store => store.delete(id));

export function readSetting(area, key) {
  try { return window[area].getItem(prefix + key) || ""; } catch { return ""; }
}
export function writeSetting(area, key, value) {
  try {
    if (value) window[area].setItem(prefix + key, value);
    else window[area].removeItem(prefix + key);
    return true;
  } catch { return false; }
}
