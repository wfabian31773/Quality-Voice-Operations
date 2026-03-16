(function () {
  var SCRIPT_TAG = document.currentScript;
  var WIDGET_TOKEN = SCRIPT_TAG ? SCRIPT_TAG.getAttribute('data-token') : '';
  var API_BASE = SCRIPT_TAG ? (SCRIPT_TAG.getAttribute('data-api') || SCRIPT_TAG.src.replace(/\/api\/widget\/embed\.js.*$/, '').replace(/\/widget\/embed\.js.*$/, '')) : '';

  if (!WIDGET_TOKEN) {
    console.error('[QVO Widget] Missing data-token attribute');
    return;
  }

  var config = null;
  var ws = null;
  var mediaStream = null;
  var audioContext = null;
  var isOpen = false;
  var isConnected = false;
  var isVoiceMode = false;
  var leadCaptured = false;
  var messages = [];
  var playbackCtx = null;
  var playbackNextTime = 0;

  var host = document.createElement('div');
  host.setAttribute('data-qvo-widget', '');
  document.body.appendChild(host);

  var shadow = host.attachShadow({ mode: 'closed' });

  var style = document.createElement('style');
  style.textContent = [
    '* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '.qvo-fab { position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px; border-radius: 28px; border: none; cursor: pointer; z-index: 999999; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: transform 0.2s, box-shadow 0.2s; }',
    '.qvo-fab:hover { transform: scale(1.05); box-shadow: 0 6px 20px rgba(0,0,0,0.2); }',
    '.qvo-fab svg { width: 24px; height: 24px; fill: white; }',
    '.qvo-panel { position: fixed; bottom: 90px; right: 24px; width: 380px; max-height: 560px; border-radius: 16px; overflow: hidden; z-index: 999999; box-shadow: 0 8px 32px rgba(0,0,0,0.15); display: none; flex-direction: column; background: #fff; }',
    '.qvo-panel.open { display: flex; }',
    '.qvo-header { padding: 16px 20px; color: white; display: flex; align-items: center; justify-content: space-between; }',
    '.qvo-header h3 { font-size: 16px; font-weight: 600; }',
    '.qvo-header button { background: none; border: none; cursor: pointer; color: white; opacity: 0.8; font-size: 18px; }',
    '.qvo-header button:hover { opacity: 1; }',
    '.qvo-body { flex: 1; overflow-y: auto; padding: 16px 20px; min-height: 300px; }',
    '.qvo-lead-form { display: flex; flex-direction: column; gap: 12px; }',
    '.qvo-lead-form label { font-size: 13px; color: #374151; font-weight: 500; }',
    '.qvo-lead-form input { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.2s; }',
    '.qvo-lead-form .qvo-btn { padding: 10px 16px; border: none; border-radius: 8px; color: white; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }',
    '.qvo-lead-form .qvo-btn:hover { opacity: 0.9; }',
    '.qvo-chat { display: flex; flex-direction: column; gap: 8px; height: 100%; }',
    '.qvo-messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 200px; }',
    '.qvo-msg { max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; word-wrap: break-word; }',
    '.qvo-msg.agent { background: #f3f4f6; color: #111827; align-self: flex-start; border-bottom-left-radius: 4px; }',
    '.qvo-msg.user { color: white; align-self: flex-end; border-bottom-right-radius: 4px; }',
    '.qvo-input-row { display: flex; gap: 8px; padding-top: 8px; border-top: 1px solid #e5e7eb; }',
    '.qvo-input-row input { flex: 1; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none; }',
    '.qvo-input-row button { padding: 10px 14px; border: none; border-radius: 8px; color: white; font-size: 14px; font-weight: 600; cursor: pointer; min-width: 60px; }',
    '.qvo-mode-toggle { display: flex; gap: 8px; margin-bottom: 12px; }',
    '.qvo-mode-btn { flex: 1; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px; background: white; cursor: pointer; font-size: 13px; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s; }',
    '.qvo-mode-btn.active { color: white; border-color: transparent; }',
    '.qvo-mode-btn svg { width: 16px; height: 16px; }',
    '.qvo-voice-area { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 32px 0; min-height: 200px; }',
    '.qvo-voice-indicator { width: 80px; height: 80px; border-radius: 40px; display: flex; align-items: center; justify-content: center; cursor: pointer; border: none; transition: transform 0.2s; }',
    '.qvo-voice-indicator:hover { transform: scale(1.05); }',
    '.qvo-voice-indicator svg { width: 32px; height: 32px; fill: white; }',
    '.qvo-voice-indicator.listening { animation: qvo-pulse 1.5s infinite; }',
    '@keyframes qvo-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0.4); } 50% { box-shadow: 0 0 0 16px rgba(99,102,241,0); } }',
    '.qvo-voice-status { font-size: 14px; color: #6b7280; }',
    '.qvo-connecting { text-align: center; padding: 40px 0; color: #6b7280; font-size: 14px; }',
    '.qvo-spinner { width: 32px; height: 32px; border: 3px solid #e5e7eb; border-radius: 50%; animation: qvo-spin 0.8s linear infinite; margin: 0 auto 12px; }',
    '@keyframes qvo-spin { to { transform: rotate(360deg); } }',
    '@media (max-width: 420px) { .qvo-panel { width: calc(100vw - 32px); right: 16px; bottom: 80px; } .qvo-fab { bottom: 16px; right: 16px; } }',
  ].join('\n');
  shadow.appendChild(style);

  var container = document.createElement('div');
  shadow.appendChild(container);

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function fetchConfig() {
    var url = API_BASE + '/api/widget/public-config?token=' + encodeURIComponent(WIDGET_TOKEN);
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        config = data.config;
      })
      .catch(function (err) {
        console.error('[QVO Widget] Failed to load config:', err);
      });
  }

  function getWsUrl() {
    var base = API_BASE || window.location.origin;
    var proto = base.indexOf('https') === 0 ? 'wss' : 'ws';
    var h = base.replace(/^https?:\/\//, '');
    return proto + '://' + h + '/widget/stream?token=' + encodeURIComponent(WIDGET_TOKEN);
  }

  function connectWs() {
    if (ws) return;
    ws = new WebSocket(getWsUrl());

    ws.onopen = function () {
      ws.send(JSON.stringify({ type: 'start' }));
    };

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === 'ready') {
          isConnected = true;
          render();
        } else if (msg.type === 'audio') {
          if (isVoiceMode) playAudio(msg.data);
        } else if (msg.type === 'transcript') {
          addMessage('agent', msg.text);
        } else if (msg.type === 'error') {
          addMessage('agent', msg.message || 'An error occurred');
        }
      } catch (e) {}
    };

    ws.onclose = function () {
      ws = null;
      isConnected = false;
      render();
    };

    ws.onerror = function () {
      ws = null;
      isConnected = false;
    };
  }

  function disconnectWs() {
    if (ws) {
      try { ws.send(JSON.stringify({ type: 'stop' })); } catch (e) {}
      ws.close();
      ws = null;
    }
    isConnected = false;
    stopVoice();
    closePlaybackCtx();
  }

  function addMessage(role, text) {
    messages.push({ role: role, text: text });
    render();
    requestAnimationFrame(function () {
      var mc = shadow.querySelector('.qvo-messages');
      if (mc) mc.scrollTop = mc.scrollHeight;
    });
  }

  function sendText(text) {
    if (!ws || !text.trim()) return;
    addMessage('user', text.trim());
    ws.send(JSON.stringify({ type: 'text', text: text.trim() }));
  }

  function startVoice() {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        mediaStream = stream;
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        var source = audioContext.createMediaStreamSource(stream);
        var processor = audioContext.createScriptProcessor(4096, 1, 1);

        source.connect(processor);
        processor.connect(audioContext.destination);

        processor.onaudioprocess = function (e) {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          var float32 = e.inputBuffer.getChannelData(0);
          var int16 = new Int16Array(float32.length);
          for (var i = 0; i < float32.length; i++) {
            var s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          var bytes = new Uint8Array(int16.buffer);
          var binary = '';
          for (var j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
          ws.send(JSON.stringify({ type: 'audio', data: btoa(binary) }));
        };

        isVoiceMode = true;
        render();
      })
      .catch(function () {
        addMessage('agent', 'Microphone access is needed for voice mode. Please allow microphone access and try again.');
      });
  }

  function stopVoice() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    if (audioContext) {
      audioContext.close().catch(function () {});
      audioContext = null;
    }
    isVoiceMode = false;
    render();
  }

  function getPlaybackCtx() {
    if (!playbackCtx || playbackCtx.state === 'closed') {
      playbackCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      playbackNextTime = 0;
    }
    return playbackCtx;
  }

  function playAudio(base64) {
    try {
      var binary = atob(base64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      var ctx = getPlaybackCtx();
      var int16 = new Int16Array(bytes.buffer);
      var float32 = new Float32Array(int16.length);
      for (var j = 0; j < int16.length; j++) {
        float32[j] = int16[j] / (int16[j] < 0 ? 0x8000 : 0x7fff);
      }

      var buffer = ctx.createBuffer(1, float32.length, 24000);
      buffer.getChannelData(0).set(float32);
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      var startTime = Math.max(ctx.currentTime, playbackNextTime);
      source.start(startTime);
      playbackNextTime = startTime + buffer.duration;
    } catch (e) {
      console.error('[QVO Widget] Audio playback error:', e);
    }
  }

  function closePlaybackCtx() {
    if (playbackCtx && playbackCtx.state !== 'closed') {
      playbackCtx.close().catch(function () {});
      playbackCtx = null;
      playbackNextTime = 0;
    }
  }

  function render() {
    if (!config) return;

    var pc = config.primaryColor || '#6366f1';
    var tn = config.tenantName || 'Assistant';

    container.innerHTML = '';

    var fab = document.createElement('button');
    fab.className = 'qvo-fab';
    fab.style.backgroundColor = pc;
    fab.innerHTML = isOpen
      ? '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
    fab.onclick = function () {
      isOpen = !isOpen;
      if (!isOpen) disconnectWs();
      render();
    };
    container.appendChild(fab);

    if (!isOpen) return;

    var panel = document.createElement('div');
    panel.className = 'qvo-panel open';

    var header = document.createElement('div');
    header.className = 'qvo-header';
    header.style.backgroundColor = pc;
    var h3 = document.createElement('h3');
    h3.textContent = tn;
    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&#10005;';
    closeBtn.onclick = function () { isOpen = false; disconnectWs(); render(); };
    header.appendChild(h3);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    var body = document.createElement('div');
    body.className = 'qvo-body';

    if (!leadCaptured && config.leadCaptureFields && config.leadCaptureFields.length > 0) {
      body.innerHTML = renderLeadForm(config, pc);
      panel.appendChild(body);
      container.appendChild(panel);

      var form = body.querySelector('.qvo-lead-form');
      if (form) {
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          leadCaptured = true;
          connectWs();
          render();
        });
      }
      return;
    }

    if (!isConnected) {
      if (!ws) connectWs();
      var spinnerColor = pc;
      body.innerHTML = '<div class="qvo-connecting"><div class="qvo-spinner" style="border-top-color:' + spinnerColor + '"></div>Connecting...</div>';
      panel.appendChild(body);
      container.appendChild(panel);
      return;
    }

    body.innerHTML = renderChat(config, pc);
    panel.appendChild(body);
    container.appendChild(panel);

    var input = body.querySelector('.qvo-text-input');
    var sendBtn = body.querySelector('.qvo-send-btn');
    if (input && sendBtn) {
      var doSend = function () { sendText(input.value); input.value = ''; };
      sendBtn.onclick = doSend;
      input.onkeydown = function (e) { if (e.key === 'Enter') doSend(); };
    }

    var textModeBtn = body.querySelector('.qvo-text-mode');
    var voiceModeBtn = body.querySelector('.qvo-voice-mode');
    if (textModeBtn) textModeBtn.onclick = function () { stopVoice(); render(); };
    if (voiceModeBtn) voiceModeBtn.onclick = function () { startVoice(); };
  }

  function renderLeadForm(cfg, pc) {
    var fieldLabels = { name: 'Your Name', email: 'Email Address', phone: 'Phone Number' };
    var fieldTypes = { name: 'text', email: 'email', phone: 'tel' };

    var fields = '';
    for (var i = 0; i < cfg.leadCaptureFields.length; i++) {
      var f = cfg.leadCaptureFields[i];
      fields += '<div><label>' + (fieldLabels[f] || f) + '</label><input type="' + (fieldTypes[f] || 'text') + '" name="' + f + '" required placeholder="' + (fieldLabels[f] || f) + '"></div>';
    }

    return '<form class="qvo-lead-form">' +
      '<p style="font-size:14px;color:#374151;margin-bottom:4px;">' + escapeHtml(cfg.greeting) + '</p>' +
      fields +
      '<button type="submit" class="qvo-btn" style="background:' + pc + '">Start Chat</button>' +
      '</form>';
  }

  function renderChat(cfg, pc) {
    var modeToggle = '';
    if (cfg.voiceEnabled && cfg.textChatEnabled) {
      modeToggle = '<div class="qvo-mode-toggle">' +
        '<button class="qvo-mode-btn qvo-text-mode ' + (!isVoiceMode ? 'active' : '') + '" style="' + (!isVoiceMode ? 'background:' + pc + ';color:white;' : '') + '">' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg> Text</button>' +
        '<button class="qvo-mode-btn qvo-voice-mode ' + (isVoiceMode ? 'active' : '') + '" style="' + (isVoiceMode ? 'background:' + pc + ';color:white;' : '') + '">' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg> Voice</button>' +
        '</div>';
    }

    if (isVoiceMode) {
      return modeToggle +
        '<div class="qvo-voice-area">' +
        '<button class="qvo-voice-indicator listening" style="background:' + pc + '">' +
        '<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg>' +
        '</button>' +
        '<span class="qvo-voice-status">Listening...</span>' +
        '</div>';
    }

    var msgHtml = '';
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var cls = m.role === 'agent' ? 'agent' : 'user';
      var bg = m.role === 'user' ? ' style="background:' + pc + '"' : '';
      msgHtml += '<div class="qvo-msg ' + cls + '"' + bg + '>' + escapeHtml(m.text) + '</div>';
    }
    if (messages.length === 0 && cfg.greeting) {
      msgHtml = '<div class="qvo-msg agent">' + escapeHtml(cfg.greeting) + '</div>';
    }

    var inputRow = '';
    if (cfg.textChatEnabled) {
      inputRow = '<div class="qvo-input-row">' +
        '<input class="qvo-text-input" type="text" placeholder="Type a message..." />' +
        '<button class="qvo-send-btn" style="background:' + pc + '">Send</button>' +
        '</div>';
    }

    return modeToggle +
      '<div class="qvo-chat">' +
      '<div class="qvo-messages">' + msgHtml + '</div>' +
      inputRow +
      '</div>';
  }

  fetchConfig().then(function () {
    if (config) render();
  });
})();
