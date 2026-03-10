// Cloudflare Worker URL（デプロイ後に更新）
const WORKER_URL = 'https://chatwork-proxy.hiiroakitmail.workers.dev';

let apiToken = '';
let myAccountId = null;
let rooms = [];
let foundMessages = [];

// --- API通信 ---
async function chatworkApi(method, path, body = null) {
  const opts = {
    method,
    headers: { 'X-ChatWork-Token': apiToken },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(body).toString();
  }

  const res = await fetch(`${WORKER_URL}/${path}`, opts);

  // レートリミット対応
  const remaining = res.headers.get('X-RateLimit-Remaining');
  if (remaining !== null && parseInt(remaining) <= 1) {
    const reset = res.headers.get('X-RateLimit-Reset');
    const waitMs = reset ? (parseInt(reset) * 1000 - Date.now() + 500) : 5000;
    if (waitMs > 0) {
      showStatus(`レートリミット到達。${Math.ceil(waitMs / 1000)}秒待機中...`, 'info');
      await sleep(waitMs);
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error: ${res.status}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Step 1: 接続 ---
async function connect() {
  apiToken = document.getElementById('api-token').value.trim();
  if (!apiToken) {
    showStatus('APIトークンを入力してください', 'error');
    return;
  }

  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  btn.textContent = '接続中...';

  try {
    const me = await chatworkApi('GET', 'me');
    myAccountId = me.account_id;

    document.getElementById('user-info').classList.remove('hidden');
    document.getElementById('user-info').textContent =
      `接続成功: ${me.name}（ID: ${me.account_id}）`;

    await loadRooms();
  } catch (err) {
    showStatus(`接続失敗: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '接続';
  }
}

// --- Step 2: ルーム一覧 ---
async function loadRooms() {
  showStatus('ルーム一覧を取得中...', 'info');

  const allRooms = await chatworkApi('GET', 'rooms');
  // グループチャットのみ（type: "group"）
  rooms = allRooms.filter(r => r.type === 'group');
  rooms.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  const listEl = document.getElementById('room-list');
  listEl.innerHTML = rooms.map((r, i) => `
    <label class="room-item">
      <input type="checkbox" data-index="${i}" checked>
      <span class="room-name">${escapeHtml(r.name)}</span>
      <span class="room-members">${r.member_count}人</span>
    </label>
  `).join('');

  document.getElementById('room-count').textContent = `${rooms.length}件のグループチャット`;
  document.getElementById('step-rooms').classList.remove('hidden');
  hideStatus();
}

function selectAllRooms() {
  document.querySelectorAll('#room-list input[type="checkbox"]').forEach(cb => cb.checked = true);
}

function deselectAllRooms() {
  document.querySelectorAll('#room-list input[type="checkbox"]').forEach(cb => cb.checked = false);
}

// --- Step 3: メッセージ検索 ---
async function searchMessages() {
  const selectedIndexes = [];
  document.querySelectorAll('#room-list input[type="checkbox"]:checked').forEach(cb => {
    selectedIndexes.push(parseInt(cb.dataset.index));
  });

  if (selectedIndexes.length === 0) {
    showStatus('ルームを選択してください', 'error');
    return;
  }

  const btn = document.getElementById('btn-search');
  btn.disabled = true;
  btn.textContent = '検索中...';

  const progressEl = document.getElementById('search-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');

  document.getElementById('step-messages').classList.remove('hidden');
  progressEl.classList.remove('hidden');

  foundMessages = [];
  const selectedRooms = selectedIndexes.map(i => rooms[i]);

  for (let i = 0; i < selectedRooms.length; i++) {
    const room = selectedRooms[i];
    const pct = Math.round(((i + 1) / selectedRooms.length) * 100);
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `${i + 1}/${selectedRooms.length}: ${room.name}`;

    try {
      // force=1 で最新100件取得
      const messages = await chatworkApi('GET', `rooms/${room.room_id}/messages?force=1`);
      if (Array.isArray(messages)) {
        const targets = messages.filter(m =>
          m.account.account_id === myAccountId &&
          m.body.includes('が追加されました')
        );
        targets.forEach(m => {
          foundMessages.push({
            roomId: room.room_id,
            roomName: room.name,
            messageId: m.message_id,
            body: m.body,
            sendTime: m.send_time,
          });
        });
      }
    } catch (err) {
      console.warn(`Room ${room.name}: ${err.message}`);
    }

    // レートリミット対策：少し待つ
    await sleep(300);
  }

  progressEl.classList.add('hidden');
  renderMessages();

  btn.disabled = false;
  btn.textContent = '選択したルームからメッセージ検索';
}

function renderMessages() {
  const listEl = document.getElementById('message-list');

  if (foundMessages.length === 0) {
    listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#999;">対象メッセージが見つかりませんでした</div>';
    document.getElementById('btn-delete').classList.add('hidden');
  } else {
    listEl.innerHTML = foundMessages.map((m, i) => `
      <div class="message-item">
        <input type="checkbox" data-index="${i}" checked>
        <div class="message-info">
          <div class="message-room">${escapeHtml(m.roomName)}</div>
          <div class="message-body">${escapeHtml(m.body)}</div>
          <div class="message-date">${formatDate(m.sendTime)}</div>
        </div>
      </div>
    `).join('');
    document.getElementById('btn-delete').classList.remove('hidden');
  }

  document.getElementById('message-count').textContent = `${foundMessages.length}件のメッセージ`;
}

function selectAllMessages() {
  document.querySelectorAll('#message-list input[type="checkbox"]').forEach(cb => cb.checked = true);
}

function deselectAllMessages() {
  document.querySelectorAll('#message-list input[type="checkbox"]').forEach(cb => cb.checked = false);
}

// --- Step 4: 削除 ---
async function deleteMessages() {
  const selectedIndexes = [];
  document.querySelectorAll('#message-list input[type="checkbox"]:checked').forEach(cb => {
    selectedIndexes.push(parseInt(cb.dataset.index));
  });

  if (selectedIndexes.length === 0) {
    showStatus('メッセージを選択してください', 'error');
    return;
  }

  if (!confirm(`${selectedIndexes.length}件のメッセージを削除します。よろしいですか？`)) {
    return;
  }

  const btn = document.getElementById('btn-delete');
  btn.disabled = true;
  btn.textContent = '削除中...';

  let successCount = 0;
  let failCount = 0;
  const results = [];

  for (const idx of selectedIndexes) {
    const m = foundMessages[idx];
    try {
      await chatworkApi('DELETE', `rooms/${m.roomId}/messages/${m.messageId}`);
      successCount++;
      results.push({ ...m, status: 'success' });
    } catch (err) {
      failCount++;
      results.push({ ...m, status: 'fail', error: err.message });
    }
    await sleep(500); // レートリミット対策
  }

  document.getElementById('step-result').classList.remove('hidden');
  document.getElementById('result-content').innerHTML = `
    <p class="result-success">削除成功: ${successCount}件</p>
    ${failCount > 0 ? `<p class="result-fail">削除失敗: ${failCount}件（自分以外の投稿または削除期限切れ）</p>` : ''}
  `;

  btn.disabled = false;
  btn.textContent = '選択したメッセージを削除';

  // 削除済みを一覧から除外
  foundMessages = foundMessages.filter((_, i) => {
    const result = results.find(r => r.messageId === foundMessages[i].messageId);
    return !result || result.status !== 'success';
  });
  renderMessages();
}

// --- ユーティリティ ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(unixTime) {
  const d = new Date(unixTime * 1000);
  return d.toLocaleString('ja-JP');
}

function showStatus(message, type) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
  if (type !== 'info') {
    setTimeout(() => el.classList.add('hidden'), 4000);
  }
}

function hideStatus() {
  document.getElementById('status').classList.add('hidden');
}

// Enterキーで接続
document.getElementById('api-token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect();
});
