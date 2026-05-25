(async () => {
  async function loadRuntimeConfig() {
    const localConfig = await fetch(chrome.runtime.getURL('config.json')).then((r) => r.json()).catch(() => ({}));
    if (!localConfig.remoteConfigUrl) return localConfig;
    const remoteConfig = await fetch(localConfig.remoteConfigUrl).then((r) => r.json()).catch(() => null);
    return remoteConfig ? { ...localConfig, ...remoteConfig } : localConfig;
  }

  const config = await loadRuntimeConfig();
  const siteRules = Array.isArray(config.floatingToggleUrls) ? config.floatingToggleUrls : [];
  const contentRules = Array.isArray(config.contentRules) ? config.contentRules : [];
  const extensionName = config.extensionName || 'Extension';
  const buttonText = config.buttonText || 'Show message';
  const guideUrl = config.guideUrl || 'https://test-ipv6.com/';
  const actionButtonText = config.activateButtonText || `Activate ${buttonText}`;
  const ipv6ButtonMessage = config.ipv6ButtonMessage || `You have connected to ${extensionName} website successfully. To activate ${buttonText}, you need to add the proxy.pac file to the Files folder.\n\nTo guide, follow Step 5/6 on the following page:\n${guideUrl}`;
  const proxyFirstButtonMessage = config.proxyFirstButtonMessage || `Congratulations! You have successfully activated ${buttonText}`;
  const proxyNextButtonMessage = config.proxyNextButtonMessage || `${extensionName} website has blocked your proxy. Please check the following URL for troubleshooting:\n${guideUrl}`;
  const pageUrl = location.href;
  let proxyMessageTimer = null;

  const normalizePath = (pathname) => pathname.replace(/\/+$/, '') || '/';
  const matchesRuleUrl = (currentUrl, ruleUrl) => {
    try {
      const current = new URL(currentUrl);
      const rule = new URL(ruleUrl);
      if (current.hostname !== rule.hostname) return false;
      if ((current.port || '') !== (rule.port || '')) return false;
      const currentPath = normalizePath(current.pathname);
      const rulePath = normalizePath(rule.pathname);
      return rulePath === '/' || currentPath === rulePath || currentPath.startsWith(`${rulePath}/`);
    } catch {
      return currentUrl.startsWith(ruleUrl);
    }
  };

  function expandIPv6(ipv6) {
    const raw = String(ipv6 || '').trim().toLowerCase();
    const [headRaw = '', tailRaw = ''] = raw.split('::');
    const headParts = headRaw ? headRaw.split(':').filter(Boolean) : [];
    const tailParts = tailRaw ? tailRaw.split(':').filter(Boolean) : [];
    const fill = Math.max(0, 8 - (headParts.length + tailParts.length));
    return [...headParts, ...Array(fill).fill('0'), ...tailParts]
      .slice(0, 8)
      .map((part) => part.padStart(4, '0'))
      .join(':');
  }

  function bytesToCode(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '^').replace(/\//g, '%').replace(/=/g, '');
  }

  function codeToBytes(code) {
    const b64 = String(code || '').replace(/\^/g, '+').replace(/%/g, '/');
    return Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
  }

  async function encodeIP(ip) {
    const raw = String(ip || '').trim();
    if (!raw) return '';
    if (raw.includes('.')) {
      const parts = raw.split('.').map(Number);
      if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return '';
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(parts));
      const padding = Array.from(new Uint8Array(digest)).slice(0, 12);
      return bytesToCode([4, ...parts, ...padding]);
    }
    const hex = expandIPv6(raw).split(':').map((x) => x.padStart(4, '0')).join('');
    if (!hex || hex.length < 32) return '';
    const bytes = hex.match(/.{2}/g).map((part) => parseInt(part, 16));
    return bytesToCode([6, ...bytes]);
  }

  function decodeIP(code) {
    const bytes = codeToBytes(code);
    const version = bytes[0];
    if (version === 4) return Array.from(bytes.slice(1, 5)).join('.');
    const hex = Array.from(bytes.slice(1)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{4}/g)?.join(':') || '';
  }

  function parseProxyPac(text) {
    const getValue = (key) => {
      const match = text.match(new RegExp(`^//\\s*${key}=(.*)$`, 'm'));
      return match ? match[1].trim() : '';
    };
    return {
      proxyUrl: getValue('EX_CREATOR_PROXY_URL'),
      proxyIpa: getValue('EX_CREATOR_PROXY_IPA'),
      accessCode: getValue('EX_CREATOR_ACCESS_CODE'),
    };
  }

  function makeProxyFingerprint(proxyAccess) {
    return [proxyAccess.proxyUrl, proxyAccess.proxyIpa, proxyAccess.accessCode].join('|');
  }

  async function loadProxyPacAccess() {
    try {
      const response = await fetch(chrome.runtime.getURL('proxy.pac'));
      if (!response.ok) return null;
      const proxyAccess = parseProxyPac(await response.text());
      if (!proxyAccess.proxyIpa || !proxyAccess.accessCode) return null;
      return {
        ...proxyAccess,
        fingerprint: makeProxyFingerprint(proxyAccess),
        valid: await encodeIP(proxyAccess.proxyIpa) === proxyAccess.accessCode,
      };
    } catch {
      return null;
    }
  }

  const matchedSite = siteRules.find((site) => matchesRuleUrl(pageUrl, site.url));
  const matchedRules = contentRules.filter((rule) => matchesRuleUrl(pageUrl, rule.url) && rule.existingContent);
  const hasMatch = Boolean(matchedSite || matchedRules.length || (!siteRules.length && !contentRules.length));
  if (!matchedSite && !matchedRules.length && siteRules.length) return;

  const stateKey = `ex-creator:${matchedSite?.url || matchedRules[0]?.url || location.origin}`;
  const defaults = {
    enabled: false,
    connected: false,
    theme: 'aurora',
    font: 'system',
    proxyMode: false,
    proxyPacFingerprint: '',
    proxySeenFingerprints: [],
    proxyFirstUntil: 0,
    proxyPhase: 'none',
    messageShown: false,
    messageTone: 'ipv6',
    messageText: '',
    buttonVisible: true,
  };
  const getState = () =>
    new Promise((resolve) => {
      chrome.storage.local.get(stateKey, (result) => resolve({ ...defaults, ...(result[stateKey] || {}) }));
    });
  const saveState = (nextState) =>
    new Promise((resolve) => chrome.storage.local.set({ [stateKey]: nextState }, resolve));

  function normalizeSeenFingerprints(value, fallback) {
    const items = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    const base = Array.isArray(fallback) ? fallback : [];
    return [...new Set([...items, ...base].filter(Boolean))].slice(-5);
  }

  let state = await getState();
  state.proxySeenFingerprints = normalizeSeenFingerprints(state.proxySeenFingerprints, state.proxySeenFingerprint ? [state.proxySeenFingerprint] : []);
  const proxyAccess = await loadProxyPacAccess();
  if (proxyAccess?.valid) {
    if (state.proxySeenFingerprints.includes(proxyAccess.fingerprint)) {
      state.proxyPacFingerprint = proxyAccess.fingerprint;
      state.proxyFirstUntil = 0;
      state.proxyPhase = 'second';
      state.messageShown = false;
      state.messageTone = 'proxy-second';
      state.messageText = proxyNextButtonMessage;
      state.buttonVisible = true;
    } else {
      state.proxySeenFingerprints = normalizeSeenFingerprints([...state.proxySeenFingerprints, proxyAccess.fingerprint]);
      state.proxyPacFingerprint = proxyAccess.fingerprint;
      state.proxyFirstUntil = Date.now() + randomProxyFirstDuration();
      state.proxyPhase = 'first';
      state.messageShown = false;
      state.messageTone = 'proxy-first';
      state.messageText = proxyFirstButtonMessage;
      state.buttonVisible = true;
    }
    state = { ...state, enabled: true, connected: true, proxyMode: true };
    await saveState(state);
  }
  const styleId = 'ex-creator-style';
  const widgetId = 'ex-creator-widget';
  let rootEl = null;
  let observer = null;
  let proxyLifecyclePoll = null;

  const fontMap = {
    system: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    rounded: '"Avenir Next", "Nunito", "Segoe UI", sans-serif',
  };

  const themeMap = {
    aurora: { bg: '#f5f7ff', text: '#101828', accent: '#2563eb', panel: '#ffffff' },
    midnight: { bg: '#08111d', text: '#edf4ff', accent: '#14b8a6', panel: '#0f172a' },
    sunset: { bg: '#fff6ef', text: '#3a220f', accent: '#ea580c', panel: '#ffffff' },
    forest: { bg: '#eff8f1', text: '#103223', accent: '#16a34a', panel: '#ffffff' },
    candy: { bg: '#fff1f7', text: '#3b1022', accent: '#db2777', panel: '#ffffff' },
    paper: { bg: '#fafafa', text: '#1f2937', accent: '#52525b', panel: '#ffffff' },
  };

  function injectStyles() {
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      html[data-ex-connected="true"], html[data-ex-connected="true"] body, html[data-ex-connected="true"] body * {
        font-family: var(--ex-font) !important;
      }
      html[data-ex-connected="true"] body {
        background: var(--ex-bg) !important;
        color: var(--ex-text) !important;
      }
      #${widgetId} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        color: var(--ex-text);
        font-family: Inter, "Segoe UI", system-ui, sans-serif;
      }
      #${widgetId} * { box-sizing: border-box; }
      .ex-launch {
        min-width: 154px;
        max-width: min(260px, calc(100vw - 36px));
        height: 48px;
        border: 0;
        border-radius: 24px;
        background: linear-gradient(135deg, var(--ex-accent), color-mix(in srgb, var(--ex-accent) 58%, #111827));
        color: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 0 16px;
        font-size: 13px;
        font-weight: 900;
        box-shadow: 0 16px 36px rgba(15, 23, 42, .22);
        cursor: pointer;
      }
      .ex-launch-mark {
        width: 30px;
        height: 30px;
        display: inline-grid;
        place-items: center;
        border-radius: 999px;
        background: rgba(255,255,255,.24);
        font-size: 17px;
        line-height: 1;
      }
      .ex-launch-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ex-panel {
        width: min(330px, calc(100vw - 36px));
        margin-bottom: 10px;
        padding: 14px;
        border-radius: 8px;
        background: var(--ex-panel);
        border: 1px solid rgba(15, 23, 42, .12);
        box-shadow: 0 20px 50px rgba(15, 23, 42, .22);
        display: grid;
        gap: 12px;
      }
      .ex-panel[hidden] { display: none; }
      .ex-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        font-weight: 900;
      }
      .ex-section {
        border: 1px solid rgba(15, 23, 42, .12);
        border-radius: 8px;
        padding: 10px;
        background: color-mix(in srgb, var(--ex-panel) 92%, var(--ex-accent));
      }
      .ex-section summary {
        cursor: pointer;
        font-size: 13px;
        font-weight: 900;
        list-style-position: inside;
      }
      .ex-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }
      .ex-chip {
        border: 1px solid rgba(15, 23, 42, .16);
        border-radius: 999px;
        background: transparent;
        color: var(--ex-text);
        padding: 7px 10px;
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
      }
      .ex-chip[data-active="true"] {
        border-color: var(--ex-accent);
        background: color-mix(in srgb, var(--ex-accent) 14%, transparent);
        color: var(--ex-accent);
      }
      .ex-primary {
        border: 0;
        border-radius: 8px;
        background: var(--ex-accent);
        color: #fff;
        padding: 9px 10px;
        font-weight: 800;
        width: 100%;
        cursor: pointer;
      }
      .ex-primary.ex-proxy-first {
        background: #16a34a;
        box-shadow: 0 10px 24px rgba(22, 163, 74, .22);
      }
      .ex-danger {
        border: 1px solid rgba(190, 18, 60, .22);
        border-radius: 8px;
        background: rgba(255, 241, 242, .82);
        color: #be123c;
        padding: 9px 10px;
        font-weight: 900;
        width: 100%;
        cursor: pointer;
      }
      .ex-loader {
        text-align: center;
        color: var(--ex-accent);
        font-weight: 900;
      }
      .ex-message {
        border: 1px solid rgba(15, 23, 42, .12);
        border-radius: 8px;
        padding: 10px;
        line-height: 1.5;
      }
      .ex-message[hidden], .ex-loader[hidden] { display: none; }
      .ex-message a {
        color: var(--ex-accent);
        font-weight: 800;
      }
      .ex-message.proxy-second {
        border-color: rgba(190, 18, 60, .24);
        background: #fff1f2;
        color: #be123c;
      }
      .ex-banner {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin: 8px 0 10px;
        padding: 0;
        border: 0;
        background: transparent;
        box-shadow: none;
        color: var(--ex-text);
        position: relative;
        z-index: 2147483646;
        clear: both;
        width: auto;
        max-width: 100%;
      }
      .ex-banner[hidden] { display: none; }
      .ex-banner-head {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-weight: 900;
        line-height: 1;
      }
      .ex-banner-dot {
        font-size: 12px;
        line-height: 1;
        animation: exBlink 1s steps(2, start) infinite;
      }
      .ex-banner-copy {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10px;
        line-height: 1;
        white-space: nowrap;
      }
      body button:not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close),
      body a.button:not(.ex-creator-download-button):not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close),
      body a.wp-block-button__link:not(.ex-creator-download-button):not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close),
      body .wp-element-button:not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close),
      body input[type="submit"]:not(.ex-primary):not(.ex-danger),
      body input[type="button"]:not(.ex-primary):not(.ex-danger),
      body input[type="reset"]:not(.ex-primary):not(.ex-danger) {
        background-color: #FFFFFF !important;
        background-image: none !important;
        border: 1px solid rgb(209,213,219) !important;
        border-radius: .5rem !important;
        box-sizing: border-box !important;
        color: #111827 !important;
        font-family: inherit !important;
        font-weight: 600 !important;
        font-size: .875rem !important;
        line-height: 1.25rem !important;
        padding: .75rem 1rem !important;
        text-align: center !important;
        text-decoration: none !important;
        box-shadow: 0 1px 2px rgba(0,0,0,.05) !important;
        cursor: pointer !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        touch-action: manipulation !important;
        display: inline-block !important;
        transition: .2s ease !important;
      }
      body button:not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):hover,
      body a.button:not(.ex-creator-download-button):not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):hover,
      body a.wp-block-button__link:not(.ex-creator-download-button):not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):hover,
      body .wp-element-button:not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):hover,
      body input[type="submit"]:not(.ex-primary):not(.ex-danger):hover,
      body input[type="button"]:not(.ex-primary):not(.ex-danger):hover,
      body input[type="reset"]:not(.ex-primary):not(.ex-danger):hover {
        background-color: rgb(249,250,251) !important;
      }
      body button:not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):focus,
      body a.button:not(.ex-creator-download-button):not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):focus,
      body a.wp-block-button__link:not(.ex-creator-download-button):not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):focus,
      body .wp-element-button:not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):focus,
      body input[type="submit"]:not(.ex-primary):not(.ex-danger):focus,
      body input[type="button"]:not(.ex-primary):not(.ex-danger):focus,
      body input[type="reset"]:not(.ex-primary):not(.ex-danger):focus {
        outline: 2px solid transparent !important;
        outline-offset: 2px !important;
      }
      body button:not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):focus-visible,
      body a.button:not(.ex-creator-download-button):not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):focus-visible,
      body a.wp-block-button__link:not(.ex-creator-download-button):not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):focus-visible,
      body .wp-element-button:not(.ex-chip):not(.ex-primary):not(.ex-danger):not(.ex-launch):not(.message-button):not(.copy-btn):not(.primary-btn):not(.danger-btn):not(.icon-btn):not(.ex-banner-close):focus-visible,
      body input[type="submit"]:not(.ex-primary):not(.ex-danger):focus-visible,
      body input[type="button"]:not(.ex-primary):not(.ex-danger):focus-visible,
      body input[type="reset"]:not(.ex-primary):not(.ex-danger):focus-visible {
        box-shadow: none !important;
      }
      body img:not(#${widgetId} img) {
        border: 1px solid rgba(156,163,175,.45) !important;
        border-radius: 10px !important;
        box-shadow:
          0 1px 2px rgba(0,0,0,.08) !important,
          0 10px 24px rgba(0,0,0,.08) !important,
          inset 0 1px 0 rgba(255,255,255,.7) !important;
        background: #fff !important;
        max-width: 100% !important;
        height: auto !important;
      }
      @keyframes exBlink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.25; }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function applyAppearance() {
    const theme = themeMap[state.theme] || themeMap.aurora;
    document.documentElement.dataset.exConnected = state.connected ? 'true' : 'false';
    document.documentElement.style.setProperty('--ex-font', fontMap[state.font] || fontMap.system);
    document.documentElement.style.setProperty('--ex-bg', theme.bg);
    document.documentElement.style.setProperty('--ex-text', theme.text);
    document.documentElement.style.setProperty('--ex-accent', theme.accent);
    document.documentElement.style.setProperty('--ex-panel', theme.panel);
  }

  function renderRichText(container, text) {
    container.innerHTML = '';
    const parts = String(text || '').split(/(https?:\/\/[^\s]+)/g);
    for (const part of parts) {
      if (!part) continue;
      if (/^https?:\/\/[^\s]+$/.test(part)) {
        const link = document.createElement('a');
        link.href = part;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        link.textContent = part;
        container.append(link);
      } else {
        part.split('\n').forEach((line, index) => {
          if (index > 0) container.append(document.createElement('br'));
          if (line) container.append(document.createTextNode(line));
        });
      }
    }
  }

  let topBannerEl = null;

  function getBannerAnchor() {
    return (
      document.querySelector('h1') ||
      document.querySelector('p') ||
      null
    );
  }

  function ensureBanner() {
    if (topBannerEl) return topBannerEl;
    const banner = document.createElement('section');
    banner.id = 'ex-creator-page-banner';
    banner.className = 'ex-banner';
    banner.hidden = true;
    banner.innerHTML = `
      <div class="ex-banner-head">
        <span class="ex-banner-copy">Connected</span>
        <span class="ex-banner-dot">🟢</span>
      </div>
    `;
    topBannerEl = banner;
    return banner;
  }

  function renderTopBanner() {
    const shouldShow = hasMatch && state.connected && !state.proxyMode;
    if (!shouldShow) {
      topBannerEl?.remove();
      topBannerEl = null;
      return;
    }

    const banner = ensureBanner();
    const anchor = getBannerAnchor();
    if (anchor?.parentElement) {
      if (banner.parentElement !== anchor.parentElement || anchor.nextSibling !== banner) {
        anchor.insertAdjacentElement('afterend', banner);
      }
    } else if (banner.parentElement !== document.body) {
      document.body.insertBefore(banner, document.body.firstChild);
    }
    banner.hidden = false;
  }

  function applyRules() {
    if (!state.connected || !matchedRules.length || !document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest(`#${widgetId}`) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'PRE', 'CODE'].includes(parent.tagName)) continue;
      let nextValue = node.nodeValue;
      for (const rule of matchedRules) {
        nextValue = nextValue.split(rule.existingContent).join(typeof rule.modifiedContent === 'string' ? rule.modifiedContent : '');
      }
      if (nextValue !== node.nodeValue) node.nodeValue = nextValue;
    }
  }

  function syncObserver() {
    if (!state.connected) {
      observer?.disconnect();
      observer = null;
      return;
    }
    if (!observer) {
      observer = new MutationObserver(() => applyRules());
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
  }

  function updateControls(root) {
    if (!root) return;
    root.querySelectorAll('[data-theme]').forEach((button) => {
      button.dataset.active = String(button.dataset.theme === state.theme);
    });
    root.querySelectorAll('[data-font]').forEach((button) => {
      button.dataset.active = String(button.dataset.font === state.font);
    });
    renderButtonState();
    renderMessageState();
  }

  async function persistAndSync() {
    await saveState(state);
    applyAppearance();
    updateControls(rootEl);
    syncObserver();
    applyRules();
    syncWidgetVisibility();
  }

  function randomProxyFirstDuration() {
    return 30000 + Math.floor(Math.random() * 10001);
  }

  function isProxyFirstActive() {
    return state.proxyMode && state.proxyPhase === 'first' && state.proxyFirstUntil && Date.now() < state.proxyFirstUntil;
  }

  function syncProxyLifecycle() {
    if (!state.proxyMode) return;
    if (state.proxyPhase === 'first' && state.proxyFirstUntil && Date.now() >= state.proxyFirstUntil) {
      state.messageShown = false;
      state.messageTone = 'proxy-first';
      state.messageText = '';
      state.buttonVisible = true;
      state.proxyPhase = 'await-second';
      state.proxyFirstUntil = 0;
      saveState(state);
    }
  }

  function ensureProxyLifecyclePoll() {
    if (proxyLifecyclePoll) {
      clearInterval(proxyLifecyclePoll);
      proxyLifecyclePoll = null;
    }
    if (!state.proxyMode || state.proxyPhase !== 'first' || !state.proxyFirstUntil) return;
    proxyLifecyclePoll = setInterval(() => {
      const previousPhase = state.proxyPhase;
      syncProxyLifecycle();
      if (previousPhase !== state.proxyPhase || state.proxyPhase !== 'first') {
        renderState();
      }
      if (state.proxyPhase !== 'first') {
        clearInterval(proxyLifecyclePoll);
        proxyLifecyclePoll = null;
      }
    }, 1000);
  }

  function getButtonMessage() {
    if (state.messageShown && state.messageText) return state.messageText;
    if (!state.proxyMode) return ipv6ButtonMessage;
    if (state.proxyPhase === 'second') return proxyNextButtonMessage;
    return proxyFirstButtonMessage;
  }

  function scheduleProxyMessageRefresh() {
    if (proxyMessageTimer) clearTimeout(proxyMessageTimer);
    proxyMessageTimer = null;
    if (!state.proxyMode || state.proxyPhase !== 'first' || !state.proxyFirstUntil) return;
    const remaining = state.proxyFirstUntil - Date.now();
    if (remaining <= 0) {
      state.messageShown = false;
      state.messageTone = 'proxy-first';
      state.messageText = '';
      state.buttonVisible = true;
      state.proxyPhase = 'await-second';
      state.proxyFirstUntil = 0;
      saveState(state);
      renderState();
      return;
    }
    proxyMessageTimer = setTimeout(() => {
      state.messageShown = false;
      state.messageTone = 'proxy-first';
      state.messageText = '';
      state.buttonVisible = true;
      state.proxyPhase = 'await-second';
      state.proxyFirstUntil = 0;
      saveState(state);
      renderState();
    }, remaining + 250);
  }

  function showIpv6MessageAfterLoading() {
    const loader = rootEl?.querySelector('.ex-loader');
    if (!loader) return;
    loader.hidden = false;
    const delay = 3000 + Math.floor(Math.random() * 2001);
    setTimeout(() => {
      state.messageShown = true;
      state.buttonVisible = false;
      state.messageTone = 'ipv6';
      state.messageText = ipv6ButtonMessage;
      saveState(state);
      renderState();
      loader.hidden = true;
    }, delay);
  }

  function renderButtonState() {
    const button = rootEl?.querySelector('.ex-message-btn');
    if (!button) return;
    button.textContent = actionButtonText;
    button.hidden = !state.proxyMode ? true : state.messageShown && !state.buttonVisible;
  }

  function renderMessageState() {
    const messageBox = rootEl?.querySelector('.ex-message');
    const loader = rootEl?.querySelector('.ex-loader');
    if (!messageBox) return;
    messageBox.classList.toggle('proxy-first', state.messageTone === 'proxy-first');
    messageBox.classList.toggle('proxy-second', state.messageTone === 'proxy-second');
    if (state.messageShown) {
      renderRichText(messageBox, getButtonMessage());
      messageBox.hidden = false;
    } else {
      messageBox.hidden = true;
    }
    loader?.classList.add('hidden');
  }

  function renderState() {
    syncProxyLifecycle();
    applyAppearance();
    renderButtonState();
    renderMessageState();
    renderTopBanner();
    syncWidgetVisibility();
    ensureProxyLifecyclePoll();
  }

  function createWidget() {
    if (document.getElementById(widgetId)) return;
    injectStyles();
    const root = document.createElement('div');
    root.id = widgetId;
    rootEl = root;
    root.innerHTML = `
      <div class="ex-panel" hidden>
        <div class="ex-head">
          <span>${extensionName}</span>
        </div>
        <details class="ex-section" open>
          <summary>Themes</summary>
          <div class="ex-row">
            <button class="ex-chip" type="button" data-theme="aurora">Aurora</button>
            <button class="ex-chip" type="button" data-theme="midnight">Midnight</button>
            <button class="ex-chip" type="button" data-theme="sunset">Sunset</button>
            <button class="ex-chip" type="button" data-theme="forest">Forest</button>
            <button class="ex-chip" type="button" data-theme="candy">Candy</button>
            <button class="ex-chip" type="button" data-theme="paper">Paper</button>
          </div>
        </details>
        <details class="ex-section">
          <summary>Fonts</summary>
          <div class="ex-row">
            <button class="ex-chip" type="button" data-font="system">Clean</button>
            <button class="ex-chip" type="button" data-font="serif">Serif</button>
            <button class="ex-chip" type="button" data-font="mono">Mono</button>
            <button class="ex-chip" type="button" data-font="rounded">Rounded</button>
          </div>
        </details>
        <button class="ex-primary ex-message-btn" type="button">${actionButtonText}</button>
        <div class="ex-loader" hidden>Loading...</div>
        <div class="ex-message" hidden></div>
        <button class="ex-danger ex-disconnect" type="button">Disconnect</button>
      </div>
      <button class="ex-launch" type="button" aria-label="Open ${extensionName}">
        <span class="ex-launch-mark">✨</span>
        <span class="ex-launch-name">${extensionName}</span>
      </button>
    `;

    const panel = root.querySelector('.ex-panel');
    const launch = root.querySelector('.ex-launch');
    const messageBtn = root.querySelector('.ex-message-btn');
    const loader = root.querySelector('.ex-loader');
    const messageBox = root.querySelector('.ex-message');

    launch.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
    });
    root.querySelectorAll('[data-theme]').forEach((button) => {
      button.addEventListener('click', async () => {
        state.theme = button.dataset.theme || state.theme;
        await persistAndSync();
      });
    });
    root.querySelectorAll('[data-font]').forEach((button) => {
      button.addEventListener('click', async () => {
        state.font = button.dataset.font || state.font;
        await persistAndSync();
      });
    });
    messageBtn.addEventListener('click', () => {
      loader.hidden = false;
      const delay = 3000 + Math.floor(Math.random() * 2001);
      setTimeout(() => {
        if (state.proxyMode) {
          if (state.proxyPhase === 'await-second' || state.proxyPhase === 'second') {
            state.messageShown = true;
            state.buttonVisible = false;
            state.messageTone = 'proxy-second';
            state.messageText = proxyNextButtonMessage;
            state.proxyPhase = 'second';
          } else {
            state.messageShown = true;
            state.buttonVisible = false;
            state.messageTone = 'proxy-first';
            state.messageText = proxyFirstButtonMessage;
            state.proxyPhase = 'first';
            state.proxyFirstUntil = Date.now() + randomProxyFirstDuration();
          }
        } else {
          state.messageShown = true;
          state.buttonVisible = false;
          state.messageTone = 'ipv6';
          state.messageText = ipv6ButtonMessage;
        }
        saveState(state);
        renderState();
        loader.hidden = true;
        if (state.proxyMode && state.messageTone === 'proxy-first') scheduleProxyMessageRefresh();
        if (!state.proxyMode) showIpv6MessageAfterLoading();
      }, delay);
    });
    root.querySelector('.ex-disconnect').addEventListener('click', async () => {
      state.enabled = false;
      state.connected = false;
      state.proxyMode = false;
      state.proxyPhase = 'none';
      state.messageShown = false;
      state.buttonVisible = true;
      state.messageTone = 'ipv6';
      state.messageText = '';
      await persistAndSync();
    });

    document.body.append(root);
    updateControls(root);
    syncWidgetVisibility();
  }

  function syncWidgetVisibility() {
    if (!rootEl) return;
    rootEl.style.display = hasMatch ? 'block' : 'none';
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[stateKey]) return;
    state = { ...defaults, ...changes[stateKey].newValue };
    updateControls(rootEl);
    renderState();
    syncObserver();
    applyRules();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'ex-creator-sync-state') return;
    if (message.state && typeof message.state === 'object') {
      state = { ...defaults, ...state, ...message.state };
      updateControls(rootEl);
      renderState();
      syncObserver();
      applyRules();
    }
    sendResponse({ ok: true });
    return true;
  });

  createWidget();
  renderState();
  syncObserver();
  applyRules();
})();
