// Firefox MV3 runs this as an extension background page (with DOM APIs).
// Audio stays local. Background-tab announcements use the best available
// English system voice, without additional popup controls.
const PLATFORMS = Object.freeze({ chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" });
const DEFAULTS = { enabled: true, volume: 0.65 };
const AI_URL = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com)\//;
let notificationQueue = Promise.resolve();

function settings() {
  return browser.storage.local.get(DEFAULTS);
}

function enqueue(task) {
  const next = notificationQueue.then(task, task);
  notificationQueue = next.catch(error => console.warn("AI done: notification failed", error));
  return next;
}

function playFile(filename, volume) {
  return new Promise(resolve => {
    const audio = new Audio(browser.runtime.getURL(filename));
    const v = Number(volume);
    audio.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULTS.volume;
    let finished = false;
    let timer;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      audio.onended = null;
      audio.onerror = null;
      resolve(result);
    };
    audio.onended = () => finish({ ok: true });
    audio.onerror = () => finish({ ok: false, reason: "Could not decode sound." });
    timer = setTimeout(() => finish({ ok: false, reason: "Sound timed out." }), 7000);
    try {
      audio.play().catch(() => finish({ ok: false, reason: "Firefox blocked sound playback." }));
    } catch (_) {
      finish({ ok: false, reason: "Sound playback unavailable." });
    }
  });
}

function synthAvailable() {
  return typeof speechSynthesis !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined";
}

// In Firefox, voices can arrive asynchronously after getVoices() is called.
// Do not poll in a tight loop; wait once for voiceschanged, with a timeout.
async function getVoices() {
  if (!synthAvailable()) return [];
  const voices = speechSynthesis.getVoices();
  if (voices.length) return voices;
  return new Promise(resolve => {
    let finished = false;
    let timer;
    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      speechSynthesis.removeEventListener?.("voiceschanged", changed);
      resolve(speechSynthesis.getVoices());
    }
    function changed() { done(); }
    speechSynthesis.addEventListener?.("voiceschanged", changed);
    timer = setTimeout(done, 1200);
  });
}

function voiceScore(voice) {
  const name = voice.name || "";
  const lang = (voice.lang || "").replaceAll("_", "-");
  let score = /^en(-|$)/i.test(lang) ? 40 : -200;
  if (/^en-US$/i.test(lang)) score += 8;
  if (/natural|neural|premium|enhanced/i.test(name)) score += 45;
  if (/aria|jenny|guy|samantha|zira|ava|allison|serena|joanna/i.test(name)) score += 16;
  if (voice.default) score += 5;
  if (/espeak|festival|robot/i.test(name)) score -= 30;
  return score;
}

function chooseVoice(voices) {
  return voices.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
}


function spokenText(platform) {
  // Spelling ChatGPT as letters improves pronunciation across system voices.
  return platform === "chatgpt" ? "Chat G P T is done." : `${PLATFORMS[platform]} is done.`;
}

async function speakName(platform, config) {
  if (!synthAvailable()) return { ok: false, reason: "Speech synthesis unavailable." };
  const voices = await getVoices();
  const voice = chooseVoice(voices);
  if (!voice || voiceScore(voice) < 0) {
    return { ok: false, reason: "No English voice available in Firefox." };
  }
  return new Promise(resolve => {
    let finished = false;
    let timer;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      utterance.onend = null;
      utterance.onerror = null;
      resolve(result);
    };
    const utterance = new SpeechSynthesisUtterance(spokenText(platform));
    utterance.voice = voice;
    utterance.lang = voice.lang || "en-US";
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = Math.min(1, Math.max(0, Number(config.volume) || 0));
    utterance.onend = () => finish({ ok: true, delivery: "speech" });
    utterance.onerror = () => finish({ ok: false, reason: "System voice could not play." });
    timer = setTimeout(() => {
      try { speechSynthesis.cancel(); } catch (_) {}
      finish({ ok: false, reason: "System voice timed out." });
    }, 7000);
    try {
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    } catch (_) {
      finish({ ok: false, reason: "System voice failed to start." });
    }
  });
}

async function playNotification(platform, away, config) {
  const ding = await playFile("ding.wav", config.volume);
  if (!ding.ok) return ding;
  if (away && Object.hasOwn(PLATFORMS, platform)) {
    const spoken = await speakName(platform, config);
    if (spoken.ok) return spoken;
    // A short platform-specific chime is preferable to the old synthetic voice.
    const fallback = await playFile(`chimes/${platform}.wav`, config.volume);
    return fallback.ok ? { ok: true, delivery: "chime-fallback", reason: spoken.reason } : fallback;
  }
  return ding;
}

async function foreground(tab) {
  if (!tab.active) return false;
  try {
    const windowInfo = await browser.windows.get(tab.windowId);
    return Boolean(windowInfo.focused);
  } catch (_) {
    return Boolean(tab.active);
  }
}

async function markTab(tab) {
  try { await browser.tabs.sendMessage(tab.id, { type: "mark-ready" }); } catch (_) {}
  try {
    await browser.tabs.update(tab.id, { highlighted: true, active: false });
  } catch (error) {
    console.debug("AI done: native tab highlight unavailable", error);
  }
}

async function onComplete(message, sender) {
  if (!sender.tab || !Number.isInteger(sender.tab.id) ||
      !AI_URL.test(sender.url || sender.tab.url || "") ||
      !Object.hasOwn(PLATFORMS, message.platform)) {
    return { ok: false, reason: "Unrecognized AI tab." };
  }
  const config = await settings();
  if (!config.enabled) return { ok: false, reason: "Alerts disabled." };
  const away = !(await foreground(sender.tab));
  if (away) await markTab(sender.tab);
  return enqueue(() => playNotification(message.platform, away, config));
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") return undefined;
  if (message.type === "ai-response-complete") return onComplete(message, sender);
  return undefined;
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  browser.tabs.sendMessage(tabId, { type: "clear-ready" }).catch(() => {});
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  browser.tabs.query({ active: true, windowId }).then(tabs => {
    for (const tab of tabs) browser.tabs.sendMessage(tab.id, { type: "clear-ready" }).catch(() => {});
  }).catch(() => {});
});
