const ui = Object.fromEntries(['bgm-grid:bgmGrid','video-input:videoInput','dropzone','drop-title:dropTitle','table-wrap:tableWrap','video-body:videoBody','video-count:count','selection-count:selectionCount','select-all:selectAll','bulk-bgm:bulkBgm','bulk-start:bulkStart','bulk-step:bulkStep','apply-bgm:applyBgm','apply-progression:applyProgression','rename-output:renameOutput','start','retry-failed:retryFailed','delete-selected:deleteSelected','download-selected:downloadSelected','summary','download-all:downloadAll','batch-downloads:batchDownloads','progress-panel:progressPanel','progress-label:progressLabel','progress-value:progressValue','progress-bar:progressBar','toast','view-input:viewInput','view-failed:viewFailed','view-done:viewDone','failed-count:failedCount','done-count:doneCount'].map(entry => {
  const [id, key = id] = entry.split(':');
  return [key, document.querySelector(`#${id}`)];
}));

let bgms = [], videos = [], batches = [], activeBatchId = null, processing = false, activeView = 'input', toastTimer, pollVersion = 0, renameOutputs = false, draggingId = null;
const selectedIds = new Set();
const cancelledUploads = new Set();
const BGM_COLORS = ['#167761', '#4169c8', '#9a5e19', '#a53e77', '#6a56bb', '#15879a', '#a14b35', '#53752a'];
const esc = value => String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const bgmColor = id => BGM_COLORS[Math.max(0, bgms.findIndex(track => track.id === id)) % BGM_COLORS.length];
const bgmNumber = id => bgms.findIndex(track => track.id === id) + 1;

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3600);
}
function filtered() {
  return activeView === 'done' ? videos.filter(video => video.status === 'done')
    : activeView === 'failed' ? videos.filter(video => video.status === 'error')
      : videos.filter(video => ['uploading', 'ready', 'processing'].includes(video.status));
}
function chosen() { return filtered().filter(video => selectedIds.has(video.id) && video.status !== 'uploading'); }
function options(selected = '') {
  return ['<option value="">选择 BGM</option>', ...bgms.map((track, index) =>
    `<option value="${track.id}" ${selected === track.id ? 'selected' : ''}>BGM ${index + 1} · ${esc(track.name)}</option>`
  )].join('');
}

function renderBgms() {
  ui.bgmGrid.innerHTML = '';
  bgms.forEach((track, index) => {
    const card = document.createElement('div');
    card.className = 'bgm-card ready';
    card.style.setProperty('--bgm-color', BGM_COLORS[index % BGM_COLORS.length]);
    card.innerHTML = `<span class="disc"></span><span class="bgm-copy"><strong><i class="bgm-color-dot"></i>BGM ${index + 1}</strong><span title="${esc(track.name)}">${esc(track.name)}</span></span><span class="check">✓</span><button class="delete-button" type="button">删除</button>`;
    card.querySelector('.delete-button').onclick = () => deleteItem('bgm', track.id);
    ui.bgmGrid.append(card);
  });
}

function renderTable() {
  const visible = filtered();
  const failed = videos.filter(video => video.status === 'error').length;
  const done = videos.filter(video => video.status === 'done').length;
  ui.count.textContent = visible.length;
  ui.selectionCount.textContent = chosen().length;
  ui.failedCount.textContent = failed;
  ui.doneCount.textContent = done;
  ['input', 'failed', 'done'].forEach(view => ui[`view${view[0].toUpperCase() + view.slice(1)}`].classList.toggle('active', activeView === view));
  document.body.dataset.view = activeView;
  ui.selectAll.checked = visible.length > 0 && visible.every(video => selectedIds.has(video.id));
  ui.selectAll.indeterminate = visible.some(video => selectedIds.has(video.id)) && !ui.selectAll.checked;
  ui.selectAll.disabled = processing || !visible.length;
  ui.dropzone.classList.toggle('compact', videos.length > 0);
  ui.dropTitle.textContent = '把视频上传至此';
  ui.tableWrap.classList.toggle('hidden', !videos.length);
  ui.videoBody.innerHTML = '';

  visible.forEach((video, index) => {
    const uploadLabel = video.uploadActive
      ? `上传中${Number.isFinite(video.uploadProgress) ? ` ${video.uploadProgress}%` : '…'}`
      : '等待上传…';
    const state = { uploading:uploadLabel, ready:'待处理', processing:'处理中…', done:'已完成', error:`失败：${video.error || '未知错误'}` }[video.status] || '待处理';
    const selectedTrack = video.bgmId ? bgms.find(track => track.id === video.bgmId) : null;
    const isReadOnly = ['done', 'error'].includes(video.status);
    const row = document.createElement('tr');
    row.draggable = activeView === 'input' && !processing;
    row.dataset.videoId = video.id;
    row.className = selectedTrack ? 'has-bgm' : 'no-bgm';
    if (selectedTrack) row.style.setProperty('--bgm-color', bgmColor(video.bgmId));
    const locked = processing || video.status === 'uploading' || isReadOnly;
    const bgmInfo = selectedTrack ? `BGM ${bgmNumber(video.bgmId)} · ${esc(selectedTrack.name)}` : video.bgmId ? 'BGM 已移除' : '未分配 BGM';
    const bgmCell = isReadOnly ? `<span class="readonly-info">${bgmInfo}</span>` : `<div class="bgm-select-wrap ${selectedTrack ? 'assigned' : ''}">${selectedTrack ? `<span class="bgm-color-dot" title="BGM ${bgmNumber(video.bgmId)}"></span>` : ''}<select class="row-select" ${locked ? 'disabled' : ''}>${options(video.bgmId)}</select></div>`;
    const timeCell = isReadOnly ? `<span class="readonly-info">${Number(video.start || 0)} 秒</span>` : `<div class="time-input row-time"><input type="number" min="0" step="0.1" value="${Number(video.start || 0)}" ${locked ? 'disabled' : ''}><span>秒</span></div>`;
    row.innerHTML = `<td><input class="row-check" type="checkbox" ${selectedIds.has(video.id) ? 'checked' : ''} ${processing || video.status === 'uploading' ? 'disabled' : ''}></td>
      <td>${String(index + 1).padStart(2, '0')}</td>
      <td><div class="filename" title="${esc(video.name)}">${esc(video.name)}</div></td>
      <td>${bgmCell}</td>
      <td>${timeCell}</td>
      <td><span class="status ${video.status}" title="${esc(video.error || '')}">${esc(state)}</span></td>
      <td>${video.output ? `<a class="download" href="/api/download-video?id=${encodeURIComponent(video.id)}">下载</a>` : '—'}</td>
      <td>${video.status === 'done' ? '<button class="reprocess-button" type="button">重新处理</button>' : video.status === 'error' ? '<button class="reprocess-button" type="button">重新设置</button>' : ''}<button class="delete-button" type="button" ${processing ? 'disabled' : ''}>删除</button></td>`;
    row.querySelector('.row-check').onchange = event => {
      event.target.checked ? selectedIds.add(video.id) : selectedIds.delete(video.id);
      renderTable(); renderControls();
    };
    row.querySelector('select')?.addEventListener('change', event => { video.bgmId = event.target.value; renderTable(); renderControls(); saveVideoDrafts([video]); });
    row.querySelector('.row-time input')?.addEventListener('change', event => { video.start = Math.max(0, Number(event.target.value) || 0); saveVideoDrafts([video]); });
    row.querySelector('.delete-button').onclick = () => deleteItem('video', video.id);
    row.querySelector('.reprocess-button')?.addEventListener('click', () => requeueVideo(video.id));
    row.addEventListener('dragstart', () => { draggingId = video.id; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { draggingId = null; row.classList.remove('dragging'); });
    row.addEventListener('dragover', event => event.preventDefault());
    row.addEventListener('drop', () => reorderVideos(video.id));
    ui.videoBody.append(row);
  });
}

function renderControls() {
  const old = ui.bulkBgm.value;
  const visible = filtered();
  const ready = videos.filter(video => video.status === 'ready');
  const failed = videos.filter(video => video.status === 'error');
  const done = videos.filter(video => video.status === 'done').length;
  const active = videos.filter(video => video.status === 'processing').length;
  const uploading = videos.some(video => video.status === 'uploading');
  const inputControls = [ui.bulkBgm.closest('label'), ui.applyBgm, ui.bulkStart.closest('label'), ui.bulkStep.closest('label'), ui.applyProgression, ui.renameOutput];
  inputControls.forEach(control => control?.classList.toggle('hidden', activeView !== 'input'));
  document.querySelector('#audio-studio')?.classList.toggle('hidden', activeView !== 'input');
  ui.bulkBgm.innerHTML = options(old);
  ui.start.classList.toggle('hidden', activeView !== 'input');
  ui.start.disabled = processing || uploading || !ready.length || ready.some(video => !video.bgmId);
  ui.start.querySelector('span').textContent = processing ? '正在批量处理…' : '开始处理';
  ui.renameOutput.classList.toggle('selected', renameOutputs);
  ui.renameOutput.textContent = renameOutputs ? '输出按 1、2、3…命名 ✓' : '按顺序命名输出';
  ui.retryFailed.textContent = '重试已选失败项';
  ui.retryFailed.classList.toggle('hidden', activeView !== 'failed' || processing || !chosen().some(video => video.status === 'error'));
  ui.deleteSelected.classList.toggle('hidden', processing || !chosen().length);
  ui.downloadAll.classList.add('hidden');
  ui.downloadSelected.classList.toggle('hidden', activeView !== 'done' || processing || !chosen().some(video => video.status === 'done'));
  ui.summary.textContent = !videos.length ? '请先添加视频'
    : activeView === 'done' ? `处理完成 ${done} 条`
      : activeView === 'failed' ? `处理失败 ${failed.length} 条`
        : processing ? `输入队列 ${ready.length + active} 条，正在处理 ${active} 条`
          : `输入队列共 ${visible.length} 条，${ready.length} 条待处理`;
  renderProgress();
  renderBatches();
}
function renderProgress() {
  const batch = batches.find(item => item.id === activeBatchId && item.status === 'processing');
  ui.progressPanel.classList.toggle('hidden', !batch);
  if (!batch) return;
  const complete = Number(batch.done || 0) + Number(batch.failed || 0);
  const total = Number(batch.total || 0);
  ui.progressLabel.textContent = `${batch.label}正在处理`;
  ui.progressValue.textContent = `${complete} / ${total}`;
  ui.progressBar.style.width = `${total ? Math.min(100, complete / total * 100) : 0}%`;
}
function renderBatches() {
  const completed = batches.filter(batch => batch.status === 'done' && Number(batch.done || 0));
  const outputTime = value => new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(Number(value || Date.now() / 1000) * 1000));
  ui.batchDownloads.innerHTML = completed.length ? `<div class="batch-head"><strong>处理批次</strong><span>每批成品独立下载</span></div><div class="batch-list">${completed.map(batch => `<div class="batch-card"><a href="/api/download-batch?id=${encodeURIComponent(batch.id)}&t=${Date.now()}"><b>${outputTime(batch.startedAt)}</b><span>${batch.done} 条成品${batch.failed ? ` · ${batch.failed} 条失败` : ''}</span><em>下载本批</em></a><button class="batch-delete" data-batch-id="${batch.id}" type="button">删除</button></div>`).join('')}</div>` : '';
  ui.batchDownloads.querySelectorAll('.batch-delete').forEach(button => button.addEventListener('click', () => deleteBatch(button.dataset.batchId)));
}
function renderAll() { renderBgms(); renderTable(); renderControls(); }

async function upload(file, kind) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try { response = await fetch(`/api/upload?kind=${kind}&name=${encodeURIComponent(file.name)}`, { method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:file, signal:controller.signal }); }
  catch (error) { throw new Error(error.name === 'AbortError' ? '上传超时，可删除后重新上传' : '本地处理服务已停止，请重新启动工具'); }
  finally { clearTimeout(timeout); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '上传失败');
  return data;
}
async function deleteItem(kind, id) {
  if (processing) return toast('请等待当前批次处理完成');
  if (kind === 'video' && id.startsWith('temp-')) {
    cancelledUploads.add(id);
    selectedIds.delete(id);
    videos = videos.filter(video => video.id !== id);
    renderAll();
    toast('已移除上传中的视频');
    return;
  }
  try {
    const response = await fetch(`/api/item?kind=${kind}&id=${encodeURIComponent(id)}`, { method:'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '删除失败');
    if (kind === 'video') pollVersion += 1;
    selectedIds.delete(id); await sync(); renderAll(); toast(kind === 'video' ? '已删除视频素材及其成品' : '已删除 BGM');
  } catch (error) { toast(error.message || '删除失败'); }
}
async function deleteSelectedVideos() {
  const targets = chosen();
  if (!targets.length) return;
  for (const video of targets) {
    try {
      const response = await fetch(`/api/item?kind=video&id=${encodeURIComponent(video.id)}`, { method:'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '删除失败');
      selectedIds.delete(video.id);
    } catch (error) { return toast(`中断：${error.message || '删除失败'}`); }
  }
  pollVersion += 1;
  await sync(); renderAll(); toast(`已删除 ${targets.length} 条已选视频及其成品`);
}
async function downloadSelected() {
  const ids = chosen().filter(video => video.status === 'done').map(video => video.id);
  if (!ids.length) return toast('请先勾选已完成的视频');
  const form = document.createElement('form');
  form.method = 'POST'; form.action = '/api/download-selected'; form.hidden = true;
  const input = document.createElement('input');
  input.name = 'ids'; input.value = ids.join(',');
  form.append(input); document.body.append(form); form.submit(); form.remove();
}
async function requeueVideo(videoId) {
  try {
    const response = await fetch('/api/requeue', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ videoId }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法重新设置');
    selectedIds.delete(videoId);
    activeView = 'input';
    await sync(); renderAll(); toast('已移回输入队列，可重新选择 BGM 和起点');
  } catch (error) { toast(error.message || '无法重新设置'); }
}
async function saveVideoDrafts(items) {
  try {
    const response = await fetch('/api/update-videos', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ items:items.map(video => ({ videoId:video.id, bgmId:video.bgmId || '', start:video.start || 0 })) }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || '设置保存失败'); }
  } catch (error) { toast(error.message || '设置保存失败'); }
}
async function persistOrder() {
  const ids = videos.filter(video => !video.id.startsWith('temp-')).map(video => video.id);
  const response = await fetch('/api/reorder', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ videoIds:ids }) });
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || '排序保存失败'); }
}
async function deleteBatch(batchId) {
  try {
    const response = await fetch(`/api/batch?id=${encodeURIComponent(batchId)}`, { method:'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '删除批次失败');
    await sync(); renderAll(); toast('已删除该批次下载记录');
  } catch (error) { toast(error.message || '删除批次失败'); }
}
async function reorderVideos(targetId) {
  if (!draggingId || draggingId === targetId || activeView !== 'input') return;
  const from = videos.findIndex(video => video.id === draggingId), to = videos.findIndex(video => video.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = videos.splice(from, 1); videos.splice(to, 0, moved); renderAll();
  try { await persistOrder(); }
  catch (error) { toast(error.message || '排序保存失败'); }
}
async function addVideos(files) {
  const valid = [...files].filter(file => file.type.startsWith('video/') || /\.(mp4|mov|m4v)$/i.test(file.name));
  if (!valid.length) return toast('没有找到可用的视频文件');
  const queue = valid.map(file => ({
    file,
    video: { id:`temp-${crypto.randomUUID()}`, name:file.name, status:'uploading', uploadActive:false, bgmId:'', start:0 }
  }));
  videos.push(...queue.map(item => item.video));
  renderTable(); renderControls();

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const item = queue[next++], { file, video } = item;
      if (!videos.includes(video)) { cancelledUploads.delete(video.id); continue; }
      video.uploadActive = true;
      renderTable(); renderControls();
      try {
        const uploaded = await upload(file, 'video');
        if (cancelledUploads.delete(video.id)) {
          await deleteItem('video', uploaded.id);
          continue;
        }
        Object.assign(video, uploaded, { status:'ready', uploadActive:false });
      }
      catch (error) {
        if (cancelledUploads.delete(video.id)) continue;
        Object.assign(video, { status:'error', uploadActive:false, error:error.message });
      }
      renderTable(); renderControls();
    }
  };
  await Promise.all(Array.from({ length:Math.min(3, queue.length) }, worker));
  try { await persistOrder(); }
  catch (error) { toast(error.message || '上传成功，但顺序保存失败'); }
}
function applyBgm() {
  const target = chosen(), id = ui.bulkBgm.value;
  if (!target.length) return toast('请先勾选视频');
  if (!id) return toast('请先选择 BGM');
  target.forEach(video => video.bgmId = id); renderTable(); renderControls(); saveVideoDrafts(target); toast(`已应用到 ${target.length} 条视频`);
}
function progression() {
  const target = chosen();
  if (!target.length) return toast('请先勾选视频');
  const first = Math.max(0, Number(ui.bulkStart.value) || 0), step = Math.max(0, Number(ui.bulkStep.value) || 0);
  target.forEach((video, index) => video.start = Number((first + step * index).toFixed(2)));
  renderTable(); saveVideoDrafts(target); toast(`已从 ${first} 秒开始，每条递增 ${step} 秒`);
}
async function processItems(items, retry = false) {
  if (!items.length) return;
  if (items.some(video => !video.bgmId)) return toast('有视频未分配 BGM');
  try {
    const response = await fetch('/api/process', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ items:items.map(video => ({ videoId:video.id, bgmId:video.bgmId, start:video.start || 0, renameOutputs })) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    processing = true; items.forEach(video => { video.status = 'ready'; video.error = ''; }); activeView = retry ? 'failed' : 'input'; renderAll(); poll(++pollVersion);
  } catch (error) { toast(error.message || '无法开始处理'); }
}
async function sync() {
  const response = await fetch('/api/state', { cache:'no-store' }), data = await response.json();
  processing = data.processing;
  bgms = data.bgms;
  batches = data.batches || [];
  activeBatchId = data.activeBatchId || null;
  renameOutputs = Boolean(data.settings?.renameOutputs);
  document.dispatchEvent(new CustomEvent('settings-sync', { detail:data.settings || {} }));
  // 服务端是唯一的列表来源，防止已删除素材被旧轮询合并回页面。
  videos = data.videos;
}
async function poll(version) {
  if (version !== pollVersion) return;
  try {
    await sync();
    if (version !== pollVersion) return;
    renderAll();
    if (processing) setTimeout(() => poll(version), 900);
    else if (videos.some(video => video.status === 'error')) { activeView = 'failed'; renderAll(); toast('处理完成，失败视频已单独列出'); }
    else { activeView = 'done'; renderAll(); toast('本批次处理完成'); }
  } catch (_) { if (processing && version === pollVersion) setTimeout(() => poll(version), 1800); }
}

ui.videoInput.onchange = event => { addVideos(event.target.files); event.target.value = ''; };
['dragenter', 'dragover'].forEach(name => ui.dropzone.addEventListener(name, event => { event.preventDefault(); ui.dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(name => ui.dropzone.addEventListener(name, event => { event.preventDefault(); ui.dropzone.classList.remove('dragover'); }));
ui.dropzone.ondrop = event => addVideos(event.dataTransfer.files);
ui.dropzone.onclick = () => ui.videoInput.click();
ui.selectAll.onchange = event => { filtered().forEach(video => event.target.checked ? selectedIds.add(video.id) : selectedIds.delete(video.id)); renderTable(); renderControls(); };
ui.applyBgm.onclick = applyBgm;
ui.applyProgression.onclick = progression;
ui.renameOutput.onclick = () => { renameOutputs = !renameOutputs; document.dispatchEvent(new CustomEvent('rename-output-change')); renderControls(); };
ui.start.onclick = () => processItems(videos.filter(video => video.status === 'ready'));
ui.retryFailed.onclick = () => processItems(chosen().filter(video => video.status === 'error'), true);
ui.deleteSelected.onclick = deleteSelectedVideos;
ui.downloadSelected.onclick = downloadSelected;
function switchView(view) { activeView = view; selectedIds.clear(); renderTable(); renderControls(); }
ui.viewInput.onclick = () => switchView('input');
ui.viewFailed.onclick = () => switchView('failed');
ui.viewDone.onclick = () => switchView('done');
renderAll();
sync().then(() => { renderAll(); if (processing) poll(++pollVersion); }).catch(() => renderAll());
