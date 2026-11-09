(() => {
  "use strict";

  const hostname = location.hostname;
  const platform = hostname === "claude.ai" ? "claude"
    : hostname === "gemini.google.com" ? "gemini" : "chatgpt";
  const displayName = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" }[platform];

  // AI sites routinely change markup (including between signed-in accounts).
  // Keep old and new assistant markers, then use a restricted conversation-text
  // fallback ONLY after a send or a visible generation control.
  const sites = {
    chatgpt: {
      generating: [
        'button[data-testid="stop-button"]',
        '[data-testid="stop-button"]',
        'button[data-stop-generating]',
        '[data-message-streaming="true"]',
        'button[aria-label="Stop streaming"]',
        'button[aria-label="Stop generating"]'
      ],
      assistant: [
        '[data-message-author-role="assistant"]',
        '[data-conversation-role="assistant"]',
        '[data-content-search-unit-key$=":assistant"]',
        '[data-turn="assistant"]',
        '[data-role="assistant"]',
        '[data-message-author="assistant"]',
        'article[data-turn="assistant"]',
        '.agent-turn'
      ]
    },
    claude: {
      generating: [
        '[data-is-streaming="true"]',
        'button[aria-label="Stop Claude"]',
        'button[aria-label="Stop response"]',
        'button[aria-label="Stop generating"]',
        'button[aria-label="Stop Response"]'
      ],
      assistant: [
        '[data-testid="assistant-message"]',
        '.font-claude-response',
        '[data-is-streaming]',
        '.standard-markdown'
      ]
    },
    gemini: {
      generating: [
        'button.send-button.stop',
        '.send-button.stop',
        'model-response[loading]',
        'model-response[aria-busy="true"]',
        'model-response [aria-busy="true"]',
        'model-response .pending',
        '[data-test-id="response-loading"]',
        'button[aria-label="Stop response"]',
        'button[aria-label="Stop generating"]',
        'mat-progress-spinner',
        'mat-progress-bar'
      ],
      assistant: [
        'model-response',
        'message-content',
        '.model-response-text',
        '.response-content'
      ]
    }
  }[platform];

  const SETTLE_MS = 1700;
  const FALLBACK_QUIET_MS = 5500;
  const CHECK_INTERVAL_MS = 450;
  const MAX_PENDING_MS = 240000;
  const NO_RESPONSE_TIMEOUT_MS = 12000;
  const STOP_LABEL = /^(?:stop|stop\s+(?:claude|response|responding|generating|generation|streaming|thinking|answering))$/i;
  const READY_PREFIX = "● READY — ";
  const excludedFromFallback = [
    'button', 'input', 'textarea', 'form', '[contenteditable]',
    '[data-user-message-bubble="true"]', '[data-content-search-unit-key$=":user"]',
    '[data-message-author-role="user"]', '[data-conversation-role="user"]',
    '[data-testid="user-message"]', '[data-turn="user"]',
    'nav', 'aside', '[role="navigation"]', '[role="menu"]', '[role="toolbar"]',
    '[role="dialog"]', '[role="status"]', '[aria-hidden="true"]',
    'script', 'style', 'noscript', '.sr-only'
  ].join(',');

  let enabled = false;
  let phase = "idle"; // idle / awaiting / generating / settling
  let promptSubmitted = false;
  let cancelled = false;
  let sawAnswerActivity = false;
  let baseline;
  let previous;
  let idleSnapshot;
  let lastAnswerChange = 0;
  let startedAt = 0;
  let signalDisappearedAt = 0;
  let pathname = location.pathname;
  let scheduledCheck;
  let lastDingAt = 0;
  let lastEvent = "Waiting for an AI response";
  let readyMarked = false;
  let plainTitle = document.title || displayName;
  let lastDetectionMethod = "none";

  function visible(element) {
    if (!element || !element.isConnected || element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function isStopControl(element) {
    const button = element && element.closest('button, [role="button"]');
    if (!button) return false;
    if (button.matches('[data-testid="stop-button"], [data-stop-generating]')) return true;
    if (platform === "gemini" && button.matches('.send-button.stop')) return true;
    const label = (button.getAttribute("aria-label") || button.getAttribute("title") || "").trim();
    return STOP_LABEL.test(label);
  }

  function generatingNow() {
    for (const selector of sites.generating) {
      for (const element of document.querySelectorAll(selector)) {
        if (visible(element)) return true;
      }
    }
    for (const button of document.querySelectorAll('button[aria-label], button[title], [role="button"][aria-label]')) {
      if (isStopControl(button) && visible(button)) return true;
    }
    return false;
  }

  function conversationTextFallback() {
    // This is for new ChatGPT layouts with no assistant-specific markers.
    // User bubbles, text editors, menus, and transient status labels are ignored.
    const root = document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('[data-app-shell-main-content-layout]');
    if (!root || typeof document.createTreeWalker !== "function") return null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const pieces = [];
    let textNode;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement;
      if (!parent || parent.closest(excludedFromFallback)) continue;
      const value = (textNode.nodeValue || "").trim();
      if (value) pieces.push(value);
    }
    return { node: root, count: 1, text: pieces.join(" ").slice(-40000), mode: "conversation fallback" };
  }

  function assistantSnapshot() {
    for (const selector of sites.assistant) {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length) {
        const node = nodes[nodes.length - 1];
        return { node, count: nodes.length, text: (node.textContent || "").trim(), mode: "assistant selector" };
      }
    }
    // The fallback can only ARM a notification if a real request has begun.
    return conversationTextFallback() || { node: null, count: 0, text: "", mode: "none" };
  }

  function insertedLength(before, after) {
    // Require at least 12 newly rendered characters, not just a changed label.
    const a = before || "", b = after || "";
    if (a === b) return 0;
    let left = 0;
    while (left < a.length && left < b.length && a[left] === b[left]) left++;
    let right = 0;
    while (right < a.length - left && right < b.length - left &&
      a[a.length - 1 - right] === b[b.length - 1 - right]) right++;
    return b.slice(left, b.length - right).trim().length;
  }

  function ensureReadyTitle() {
    if (!readyMarked) return;
    const current = document.title || "";
    if (current.startsWith(READY_PREFIX)) {
      plainTitle = current.slice(READY_PREFIX.length);
    } else if (current) {
      plainTitle = current;
    }
    const wanted = READY_PREFIX + plainTitle;
    if (current !== wanted) document.title = wanted;
  }

  function clearReady() {
    if (!readyMarked) return;
    readyMarked = false;
    if (document.title.startsWith(READY_PREFIX)) {
      document.title = document.title.slice(READY_PREFIX.length);
    }
  }

  function reset() {
    phase = "idle";
    promptSubmitted = false;
    cancelled = false;
    sawAnswerActivity = false;
    startedAt = 0;
    lastAnswerChange = 0;
    signalDisappearedAt = 0;
    baseline = undefined;
    previous = undefined;
    idleSnapshot = assistantSnapshot();
  }

  function start(fromPrompt) {
    if (phase === "idle") {
      baseline = idleSnapshot || assistantSnapshot();
      previous = baseline;
      sawAnswerActivity = false;
      cancelled = false;
      startedAt = Date.now();
      promptSubmitted = Boolean(fromPrompt);
    }
    phase = fromPrompt ? "awaiting" : "generating";
    lastEvent = fromPrompt ? "Prompt submitted; waiting for response" : "Generation detected";
  }

  function armPrompt() {
    if (!enabled || phase === "generating" || phase === "settling") return;
    if (phase === "idle") start(true);
    else {
      baseline = assistantSnapshot();
      previous = baseline;
      sawAnswerActivity = false;
      startedAt = Date.now();
    }
    promptSubmitted = true;
  }

  function trackAnswer(snapshot) {
    if (!previous) previous = snapshot;
    const newNode = snapshot.node &&
      (snapshot.node !== baseline.node || snapshot.count > baseline.count);
    const changedText = snapshot.text !== previous.text;
    const newText = insertedLength(baseline.text, snapshot.text);
    const isFallback = snapshot.mode === "conversation fallback" || baseline.mode === "conversation fallback";
    // For the fallback, never mistake a large existing page for new content.
    const qualified = isFallback ? newText >= 12 :
      snapshot.text.length >= 12 && (newNode || newText >= 12);
    if (qualified && (promptSubmitted || phase === "generating" || phase === "settling")) {
      if (!sawAnswerActivity || changedText) lastAnswerChange = Date.now();
      sawAnswerActivity = true;
      lastDetectionMethod = snapshot.mode;
      lastEvent = "New AI response content detected";
    }
    previous = snapshot;
  }

  function complete() {
    if (!enabled || cancelled || !sawAnswerActivity) return;
    if (Date.now() - lastDingAt >= 1500) {
      lastDingAt = Date.now();
      lastEvent = "Response complete; alert requested";
      browser.runtime.sendMessage({ type: "ai-response-complete", platform }).catch(() => {});
    }
    reset();
  }

  function check() {
    scheduledCheck = undefined;
    if (!enabled) return;
    ensureReadyTitle();

    if (location.pathname !== pathname) {
      pathname = location.pathname;
      if (phase === "idle" || (phase !== "idle" && !promptSubmitted)) reset();
    }

    const generating = generatingNow();
    const snapshot = assistantSnapshot();
    const now = Date.now();

    if (phase === "idle") {
      if (generating) {
        start(false);
        trackAnswer(snapshot);
      } else {
        idleSnapshot = snapshot;
      }
      return;
    }

    trackAnswer(snapshot);
    if (now - startedAt > MAX_PENDING_MS) { lastEvent = "Generation timed out"; reset(); return; }

    if (cancelled) {
      if (!generating) { lastEvent = "Stopped manually; no alert"; reset(); }
      return;
    }

    if (generating) {
      phase = "generating";
      signalDisappearedAt = 0;
      return;
    }

    if (phase === "generating") {
      phase = "settling";
      signalDisappearedAt = now;
    }

    if (phase === "settling") {
      if (sawAnswerActivity && now - signalDisappearedAt >= SETTLE_MS &&
          now - lastAnswerChange >= SETTLE_MS) {
        complete();
      } else if (!sawAnswerActivity && now - signalDisappearedAt >= NO_RESPONSE_TIMEOUT_MS) {
        lastEvent = "No new response found";
        reset();
      }
      return;
    }

    // For layouts with no recognizable Stop control: a submitted prompt AND
    // new assistant/conversation content are both required, then quiet time.
    if (phase === "awaiting" && promptSubmitted && sawAnswerActivity &&
        now - lastAnswerChange >= FALLBACK_QUIET_MS) complete();
  }

  function scheduleCheck() {
    if (scheduledCheck !== undefined) return;
    scheduledCheck = setTimeout(check, 80);
  }

  function isEditor(element) {
    return Boolean(element && element.closest(
      '#prompt-textarea, .ProseMirror[contenteditable="true"], .ql-editor, ' +
      'form[data-chatgpt-composer] [contenteditable="true"], ' +
      'rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"], ' +
      'textarea, [contenteditable="true"]'
    ));
  }

  function isSendControl(element) {
    const button = element && element.closest('button, [role="button"]');
    if (!button || isStopControl(button)) return false;
    if (button.matches('button[data-testid="send-button"], button.send-button, .send-button')) return true;
    const label = button.getAttribute("aria-label") || "";
    if (/^send(?:\s+(?:message|prompt))?$/i.test(label)) return true;
    return button.matches('button[type="submit"]') && Boolean(button.closest('form'));
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing &&
        !event.ctrlKey && !event.altKey && isEditor(event.target)) armPrompt();
  }, true);

  document.addEventListener("click", (event) => {
    if (isStopControl(event.target)) cancelled = true;
    else if (isSendControl(event.target)) armPrompt();
  }, true);

  // Catch forms that send prompts through an icon-only submit button.
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form?.matches('form') &&
        form.querySelector('textarea, [contenteditable="true"], #prompt-textarea')) armPrompt();
  }, true);

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "mark-ready") {
      readyMarked = true;
      ensureReadyTitle();
    }
    if (message?.type === "clear-ready") clearReady();
    if (message?.type === "get-detector-status") {
      return Promise.resolve({ platform, phase, lastEvent, method: lastDetectionMethod, readyMarked });
    }
    return undefined;
  });

  // Clear the tab marker when its content is actually revisited.
  window.addEventListener("focus", () => {
    if (document.visibilityState === "visible") clearReady();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.hasFocus()) clearReady();
  });

  idleSnapshot = assistantSnapshot();
  browser.storage.local.get({ enabled: true }).then(({ enabled: value }) => {
    enabled = Boolean(value);
    scheduleCheck();
  }).catch(() => {});

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.enabled) return;
    enabled = Boolean(changes.enabled.newValue);
    reset();
    scheduleCheck();
  });

  const observer = new MutationObserver(scheduleCheck);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-busy", "data-is-streaming", "data-message-streaming",
      "data-stop-generating", "data-conversation-role", "data-content-search-unit-key",
      "class", "style", "title", "loading"]
  });
  setInterval(check, CHECK_INTERVAL_MS);
})();
