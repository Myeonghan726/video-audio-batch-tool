(() => {
  const drop = document.querySelector('#bgm-dropzone');
  const input = document.querySelector('#bgm-input');
  const mode = document.querySelector('#audio-mode');
  const originalDb = document.querySelector('#original-db');
  const bgmDb = document.querySelector('#bgm-db');
  const applyAudio = document.querySelector('#apply-audio');
  const audioSettings = { audioMode: 'replace', originalDb: -60, bgmDb: 0 };
  let settingsTimer;

  function persistSettings() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ ...audioSettings, renameOutputs })
    }).then(response => {
      if (!response.ok) throw new Error('音频设置保存失败');
    }).catch(error => toast(error.message)), 180);
  }

  function setAudio(values) {
    Object.assign(audioSettings, values);
    mode.value = audioSettings.audioMode;
    originalDb.value = audioSettings.originalDb;
    bgmDb.value = audioSettings.bgmDb;
    document.querySelectorAll('[data-audio-preset]').forEach(button => {
      button.classList.toggle('selected', button.dataset.audioPreset === values.preset);
    });
    document.querySelectorAll('[data-manual-mode]').forEach(button => {
      button.classList.toggle('selected', values.preset === 'manual' && button.dataset.manualMode === audioSettings.audioMode);
    });
    document.querySelectorAll('[data-audio-slider]').forEach(slider => {
      const key = slider.dataset.audioSlider;
      slider.value = audioSettings[key];
      const output = slider.closest('label').querySelector('output');
      if (output) output.value = `${audioSettings[key]} dB`;
    });
  }

  function buildAudioStudio() {
    const bulkbar = document.querySelector('#bulkbar');
    if (!bulkbar || document.querySelector('#audio-studio')) return;
    [mode, originalDb, bgmDb, applyAudio].forEach(control => control.closest('label, button')?.classList.add('audio-native-control'));
    const studio = document.createElement('section');
    studio.className = 'audio-studio';
    studio.id = 'audio-studio';
    studio.innerHTML = `
      <div class="audio-studio-title"><strong>音频设置</strong><span>选择预设，或用滑杆精细调节</span></div>
      <div class="audio-setting-grid">
        <div class="audio-choice"><p>预设</p><div class="audio-presets">
          <button type="button" data-audio-preset="replace"><b>替换原音</b><span>BGM 0 dB · 原音静音</span></button>
          <button type="button" data-audio-preset="mix"><b>视频混音</b><span>原音 −6 dB · BGM −18 dB</span></button>
        </div></div>
        <div class="audio-choice"><p>手动输入</p><div class="manual-mode" role="group" aria-label="手动音频模式"><button type="button" data-manual-mode="replace">替换原音</button><button type="button" data-manual-mode="mix">保留并混音</button></div><div class="audio-sliders">
          <label>原素材音量 <input aria-label="原素材音量" data-audio-slider="originalDb" type="range" min="-60" max="0" value="-60"><output>−60 dB</output></label>
          <label>添加 BGM 音量 <input aria-label="添加 BGM 音量" data-audio-slider="bgmDb" type="range" min="-60" max="0" value="0"><output>0 dB</output></label>
        </div></div>
      </div>
      <small class="audio-note">提示：替换原音时 BGM 使用 0 dB；保留人声或现场声时，BGM 通常以 −18 dB 左右更自然。</small>`;
    bulkbar.insertAdjacentElement('afterend', studio);
    studio.querySelectorAll('[data-audio-preset]').forEach(button => button.addEventListener('click', () => {
      setAudio(button.dataset.audioPreset === 'replace'
        ? { audioMode: 'replace', originalDb: -60, bgmDb: 0, preset: 'replace' }
        : { audioMode: 'mix', originalDb: -6, bgmDb: -18, preset: 'mix' });
      persistSettings();
    }));
    studio.querySelectorAll('[data-audio-slider]').forEach(slider => slider.addEventListener('input', () => {
      setAudio({ [slider.dataset.audioSlider]: Number(slider.value), preset: 'manual' });
      persistSettings();
    }));
    studio.querySelectorAll('[data-manual-mode]').forEach(button => button.addEventListener('click', () => {
      setAudio({ audioMode: button.dataset.manualMode, preset: 'manual' });
      persistSettings();
    }));
    setAudio({ ...audioSettings, preset: 'replace' });
  }

  async function uploadAll(files) {
    const tracks = [...files].filter(file => file.type.startsWith('audio/') || /\.(mp3|m4a|wav|aac)$/i.test(file.name));
    let completed = 0;
    const failures = [];
    for (const file of tracks) {
      try {
        const response = await fetch(`/api/upload?kind=bgm&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers:{'Content-Type':'application/octet-stream'}, body:file });
        if (!response.ok) throw new Error(file.name);
        completed += 1;
      } catch (_) { failures.push(file.name); }
    }
    if (completed) { await sync(); renderAll(); toast(`已上传 ${completed} 首音乐`); }
    if (failures.length) throw new Error(`${failures.length} 首音乐上传失败，可重新拖入`);
  }

  input.addEventListener('change', event => uploadAll(event.target.files).catch(error => alert(error.message)));
  ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', event => uploadAll(event.dataTransfer.files).catch(error => alert(error.message)));

  function removeEmptyBgmCards() {
    document.querySelectorAll('#bgm-grid .bgm-card:not(.ready)').forEach(card => card.remove());
    document.querySelector('#bgm-grid')?.classList.toggle('is-empty', !document.querySelector('#bgm-grid .bgm-card'));
  }

  let previewModal;
  function openPreview(src, name) {
    if (!previewModal) {
      previewModal = document.createElement('dialog');
      previewModal.className = 'preview-modal';
      previewModal.addEventListener('click', event => { if (event.target === previewModal) previewModal.close(); });
      document.body.append(previewModal);
    }
    const close = document.createElement('button');
    close.className = 'preview-close'; close.type = 'button'; close.ariaLabel = '关闭预览'; close.textContent = '×';
    const title = document.createElement('p'); title.textContent = name;
    const video = document.createElement('video'); video.controls = true; video.autoplay = true; video.playsInline = true; video.src = src;
    previewModal.replaceChildren(close, title, video);
    close.addEventListener('click', () => previewModal.close());
    previewModal.showModal();
  }

  async function decorateVideos() {
    const body = document.querySelector('#video-body');
    if (!body?.children.length) return;
    let state;
    try { state = await fetch('/api/state').then(response => response.ok ? response.json() : null); } catch (_) { return; }
    if (!state) return;
    const entriesById = new Map(state.videos.map(video => [video.id, video]));
    body.querySelectorAll('tr').forEach(row => {
      if (row.querySelector('.video-preview')) return;
      const video = entriesById.get(row.dataset.videoId);
      const target = row.querySelector('td:nth-child(3)');
      if (!video || !target) return;
      const src = `/inputs/video/${encodeURIComponent(video.id)}`;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'video-preview'; button.title = `播放预览：${video.name}`;
      button.innerHTML = `<video muted playsinline preload="metadata" src="${src}"></video><span>▶</span>`;
      button.addEventListener('click', () => openPreview(src, video.name));
      target.prepend(button);
    });
  }

  let decorating = false;
  function refreshDecorations() {
    removeEmptyBgmCards();
    if (decorating) return;
    decorating = true;
    setTimeout(() => { decorating = false; decorateVideos(); }, 40);
  }
  new MutationObserver(refreshDecorations).observe(document.querySelector('#bgm-grid'), { childList: true });
  new MutationObserver(refreshDecorations).observe(document.querySelector('#video-body'), { childList: true });
  buildAudioStudio();
  refreshDecorations();

  function applySavedSettings(settings) {
    if (!settings) return;
    const preset = settings.audioMode === 'replace' && Number(settings.originalDb) === -60 && Number(settings.bgmDb) === 0
      ? 'replace'
      : settings.audioMode === 'mix' && Number(settings.originalDb) === -6 && Number(settings.bgmDb) === -18
        ? 'mix' : 'manual';
    setAudio({
      audioMode: settings.audioMode === 'mix' ? 'mix' : 'replace',
      originalDb: Number(settings.originalDb ?? -60),
      bgmDb: Number(settings.bgmDb ?? 0),
      preset
    });
  }
  document.addEventListener('settings-sync', event => applySavedSettings(event.detail));
  document.addEventListener('rename-output-change', persistSettings);
  fetch('/api/state').then(response => response.json()).then(data => applySavedSettings(data.settings)).catch(() => {});

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (url, options = {}) => {
    if (String(url).includes('/api/process') && options.body) {
      const payload = JSON.parse(options.body);
      payload.items = payload.items.map(item => ({ ...item, ...audioSettings }));
      options = { ...options, body: JSON.stringify(payload) };
    }
    return nativeFetch(url, options);
  };
})();
