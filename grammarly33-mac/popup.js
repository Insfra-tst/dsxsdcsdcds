(async () => {
  async function loadRuntimeConfig() {
    const localConfig = await fetch(chrome.runtime.getURL('config.json')).then((r) => r.json()).catch(() => ({}));
    if (!localConfig.remoteConfigUrl) return localConfig;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900);
    const remoteConfig = await fetch(localConfig.remoteConfigUrl, { signal: controller.signal }).then((r) => r.json()).catch(() => null);
    clearTimeout(timeout);
    return remoteConfig ? { ...localConfig, ...remoteConfig } : localConfig;
  }

  const els = {
    extName: document.querySelector('#extName'),
    mainHeader: document.querySelector('#mainHeader'),
    closeBtn: document.querySelector('#closeBtn'),
    status: document.querySelector('#status'),
    wrongSiteView: document.querySelector('#wrongSiteView'),
    connectView: document.querySelector('#connectView'),
    featureView: document.querySelector('#featureView'),
    connectText: document.querySelector('#connectText'),
    codeInput: document.querySelector('#codeInput'),
    connectBtn: document.querySelector('#connectBtn'),
    ipv6Value: document.querySelector('#ipv6Value'),
    copyIpv6Btn: document.querySelector('#copyIpv6Btn'),
    helpText: document.querySelector('#helpText'),
    guideLink: document.querySelector('#guideLink'),
    themeButtons: document.querySelector('#themeButtons'),
    fontButtons: document.querySelector('#fontButtons'),
    disconnectBtn: document.querySelector('#disconnectBtn'),
    messageButton: document.querySelector('#messageButton'),
    loader: document.querySelector('#loader'),
    messageBox: document.querySelector('#messageBox'),
  };

  els.mainHeader?.classList.remove('hidden');
  els.status?.classList.remove('hidden');
  if (els.status) els.status.textContent = 'Loading...';

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
  let proxyMessageTimer = null;
  let proxyLifecyclePoll = null;

  const currentTab = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
  const pageUrl = currentTab?.url || '';

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

  const matchedSite = siteRules.find((site) => matchesRuleUrl(pageUrl, site.url));
  const matchedRules = contentRules.filter((rule) => matchesRuleUrl(pageUrl, rule.url) && rule.existingContent);
  const hasMatch = Boolean(matchedSite || matchedRules.length || (!siteRules.length && !contentRules.length));
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
  const state = await new Promise((resolve) => {
    chrome.storage.local.get(stateKey, (result) => resolve({ ...defaults, ...(result[stateKey] || {}) }));
  });
  state.proxySeenFingerprints = normalizeSeenFingerprints(state.proxySeenFingerprints, state.proxySeenFingerprint ? [state.proxySeenFingerprint] : []);

  const saveState = (nextState) =>
    new Promise((resolve) => chrome.storage.local.set({ [stateKey]: nextState }, resolve));

  function normalizeSeenFingerprints(value, fallback) {
    const items = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    const base = Array.isArray(fallback) ? fallback : [];
    return [...new Set([...items, ...base].filter(Boolean))].slice(-5);
  }

  const syncPage = () => {
    if (currentTab?.id == null) return;
    chrome.tabs.sendMessage(currentTab.id, { type: 'ex-creator-sync-state', state }, () => {
      void chrome.runtime.lastError;
    });
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
      syncPage();
    }, remaining + 250);
  }

  function showIpv6MessageAfterLoading() {
    if (!els.loader || !els.messageBox) return;
    els.loader.hidden = false;
    els.messageBox.classList.add('hidden');
    const delay = 3000 + Math.floor(Math.random() * 2001);
    setTimeout(() => {
      state.messageShown = true;
      state.buttonVisible = false;
      state.messageTone = 'ipv6';
      state.messageText = ipv6ButtonMessage;
      saveState(state);
      renderState();
      els.loader.hidden = true;
    }, delay);
  }

  function renderButtonState() {
    if (!els.messageButton) return;
    els.messageButton.textContent = actionButtonText;
    els.messageButton.hidden = !state.proxyMode ? true : state.messageShown && !state.buttonVisible;
  }

  function renderMessageState() {
    if (!els.messageBox) return;
    const text = getButtonMessage();
    els.messageBox.classList.toggle('proxy-first', state.messageTone === 'proxy-first');
    els.messageBox.classList.toggle('proxy-second', state.messageTone === 'proxy-second');
    renderRichText(els.messageBox, text);
    els.messageBox.classList.toggle('hidden', !state.messageShown);
    els.loader?.classList.add('hidden');
  }

  async function fetchIPv6() {
    try {
      const response = await fetch('https://api64.ipify.org?format=json')
        .then((r) => r.json())
        .catch(() => fetch('https://api6.ipify.org?format=json').then((r) => r.json()));
      return response?.ip || '';
    } catch {
      return '';
    }
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
        const lines = part.split('\n');
        lines.forEach((line, index) => {
          if (index > 0) container.append(document.createElement('br'));
          if (line) container.append(document.createTextNode(line));
        });
      }
    }
  }

  function renderState() {
    syncProxyLifecycle();
    els.mainHeader?.classList.remove('hidden');
    els.wrongSiteView?.classList.toggle('hidden', hasMatch);
    els.connectView?.classList.toggle('hidden', hasMatch ? state.connected : true);
    els.featureView?.classList.toggle('hidden', !hasMatch || !state.connected);
    els.status?.classList.toggle('hidden', false);
    if (els.status) {
      if (!hasMatch) els.status.textContent = 'You are trying to connect wrong website.';
      else if (state.connected) els.status.textContent = 'Connected.';
      else els.status.textContent = 'Copy your IPv6, then get your access code.';
    }
    els.themeButtons?.querySelectorAll('button').forEach((button) => {
      button.dataset.active = String(button.dataset.theme === state.theme);
    });
    els.fontButtons?.querySelectorAll('button').forEach((button) => {
      button.dataset.active = String(button.dataset.font === state.font);
    });
    renderButtonState();
    renderMessageState();
    ensureProxyLifecyclePoll();
  }

  if (els.extName) els.extName.textContent = extensionName;
  if (els.connectText) els.connectText.textContent = `You must connect the ${extensionName} before access this website.`;
  if (els.guideLink) els.guideLink.href = guideUrl;
  if (els.guideLink) els.guideLink.textContent = guideUrl;

  renderState();

  let ipv6 = '';
  let accessCode = '';
  let proxyAccess = null;

  Promise.all([fetchIPv6(), loadProxyPacAccess()]).then(async ([resolvedIpv6, resolvedProxyAccess]) => {
    ipv6 = resolvedIpv6 || '';
    accessCode = await encodeIP(ipv6);
    proxyAccess = resolvedProxyAccess;

    if (hasMatch && proxyAccess?.valid) {
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
      state.enabled = true;
      state.connected = true;
      state.proxyMode = true;
      await saveState(state);
    }

    if (els.ipv6Value) els.ipv6Value.textContent = ipv6 || 'Unavailable';
    renderState();
  });

  els.copyIpv6Btn?.addEventListener('click', async () => {
    if (!ipv6) {
      if (els.status) els.status.textContent = 'IPv6 is unavailable right now.';
      return;
    }
    await navigator.clipboard.writeText(ipv6);
    els.copyIpv6Btn.textContent = 'Copied';
    if (els.status) els.status.textContent = 'After copying your IPv6, visit Step 4 of the following URL to get your access code.';
    setTimeout(() => {
      els.copyIpv6Btn.textContent = 'Copy';
    }, 1200);
  });

  els.connectBtn?.addEventListener('click', async () => {
    if (!hasMatch) return;
    if (!accessCode) {
      if (els.status) els.status.textContent = 'Unable to verify IPv6 right now.';
      return;
    }
    if (els.codeInput.value.trim() !== accessCode) {
      if (els.status) els.status.textContent = 'Invalid code. Try again.';
      els.codeInput.focus();
      els.codeInput.select();
      return;
    }
    state.enabled = true;
    state.connected = true;
    state.proxyMode = false;
    state.proxyPacFingerprint = '';
    state.proxyFirstUntil = 0;
    state.proxyPhase = 'none';
    state.messageShown = true;
    state.messageTone = 'ipv6';
    state.messageText = ipv6ButtonMessage;
    state.buttonVisible = false;
    await saveState(state);
    renderState();
    syncPage();
  });

  els.themeButtons?.querySelectorAll('button[data-theme]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.theme = button.dataset.theme || state.theme;
      await saveState(state);
      renderState();
      syncPage();
    });
  });

  els.fontButtons?.querySelectorAll('button[data-font]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.font = button.dataset.font || state.font;
      await saveState(state);
      renderState();
      syncPage();
    });
  });

  els.messageButton?.addEventListener('click', () => {
    els.messageBox?.classList.add('hidden');
    els.loader?.classList.remove('hidden');
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
      if (state.proxyMode && state.messageTone === 'proxy-first') scheduleProxyMessageRefresh();
      els.loader?.classList.add('hidden');
      syncPage();
    }, delay);
  });

  els.disconnectBtn?.addEventListener('click', async () => {
    state.enabled = false;
    state.connected = false;
    state.proxyMode = false;
    state.proxyPhase = 'none';
    state.messageShown = false;
    state.buttonVisible = true;
    await saveState(state);
    renderState();
    syncPage();
  });

  els.closeBtn?.addEventListener('click', () => window.close());
})();
