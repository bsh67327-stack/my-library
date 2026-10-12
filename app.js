// =====================================================
// 내 서재 - 웹툰/웹소설/만화책 기록 앱
// =====================================================

// ----- 1. 기본 설정 -----
const TYPES = { webtoon: '웹툰', webnovel: '웹소설', comic: '만화책' };
const STATUSES = { reading: '보는 중', done: '완독', paused: '보류', dropped: '하차' };

// 화면 상태: 지금 어떤 필터/정렬을 보고 있는지
const view = { type: 'all', status: 'all', sort: 'updated', query: '' };

let works = [];         // 저장된 모든 작품
let editingId = null;   // 수정 중인 작품 id (새로 추가할 땐 null)
let formCover = '';     // 입력창에서 고른 표지 (이미지 데이터 또는 주소)
let formRating = 0;     // 입력창에서 고른 평점 (0 = 평점 없음)

// 자주 쓰는 화면 요소
const $ = (id) => document.getElementById(id);


// ----- 2. 저장소 (IndexedDB: 브라우저 안의 데이터베이스) -----
const DB_NAME = 'my-library';
const STORE = 'works';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 데이터베이스 작업 하나를 실행하고 끝나면 결과를 돌려줌
function runStore(mode, action) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = action(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

const loadAll = () => runStore('readonly', (s) => s.getAll());
const saveOne = (work) => runStore('readwrite', (s) => s.put(work));
const deleteOne = (id) => runStore('readwrite', (s) => s.delete(id));


// ----- 3. 작은 도우미 함수들 -----

// 사용자가 입력한 글자를 화면에 안전하게 넣기 위한 변환
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 별 5개 그리기 (rating이 3.5면 별 3개 반이 칠해짐)
function starsHTML(rating) {
  let html = '';
  for (let i = 0; i < 5; i++) {
    const fill = Math.max(0, Math.min(1, rating - i)) * 100;
    html += `<span class="star" data-i="${i}" style="--fill:${fill}%">★</span>`;
  }
  return html;
}

// 큰 사진을 작게 줄여서 저장 공간 아끼기
function resizeImage(file, maxWidth = 400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}


// ----- 4. 서재 화면 그리기 -----
function render() {
  const q = view.query.trim().toLowerCase();

  // (1) 거르기
  let list = works.filter((w) =>
    (view.type === 'all' || w.type === view.type) &&
    (view.status === 'all' || w.status === view.status) &&
    (!q || [w.title, w.author, w.review, w.platform].some((t) => (t || '').toLowerCase().includes(q)))
  );

  // (2) 정렬하기
  const sorters = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    rating: (a, b) => b.rating - a.rating || b.updatedAt - a.updatedAt,
    title: (a, b) => a.title.localeCompare(b.title, 'ko'),
  };
  list.sort(sorters[view.sort]);

  // (3) 카드 만들기
  $('grid').innerHTML = list.map((w) => `
    <article class="card" data-id="${esc(w.id)}">
      <div class="cover">
        <span class="cover-fallback">${esc(w.title)}</span>
        ${w.cover ? `<img src="${esc(w.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <span class="badge">${TYPES[w.type]}</span>
      </div>
      <div class="info">
        <div class="stars small">${starsHTML(w.rating)}</div>
        <h3 title="${esc(w.title)}">${esc(w.title)}</h3>
        <p class="author">${esc([w.author, w.platform].filter(Boolean).join(' · ') || ' ')}</p>
        <span class="status status-${w.status}">${STATUSES[w.status]}</span>
        ${w.review ? `<p class="review">“${esc(w.review)}”</p>` : ''}
      </div>
    </article>
  `).join('');

  // (4) 비어 있을 때 안내 문구
  const empty = $('empty');
  empty.hidden = list.length > 0;
  empty.innerHTML = works.length === 0
    ? '아직 기록한 작품이 없어요.<br>오른쪽 아래 <b>＋</b> 버튼으로 첫 작품을 추가해 보세요!'
    : '조건에 맞는 작품이 없어요.';

  renderStats();
}

function renderStats() {
  const done = works.filter((w) => w.status === 'done').length;
  const rated = works.filter((w) => w.rating > 0);
  const avg = rated.length ? (rated.reduce((s, w) => s + w.rating, 0) / rated.length).toFixed(1) : '-';
  $('stats').textContent = `전체 ${works.length}작품 · 완독 ${done} · 평균 평점 ★ ${avg}`;
}


// ----- 5. 작품 추가/수정 창 -----
function openEditor(work) {
  editingId = work ? work.id : null;
  $('editorTitle').textContent = work ? '작품 수정' : '작품 추가';
  $('deleteBtn').hidden = !work;

  $('f-title').value = work?.title || '';
  $('f-type').value = work?.type || (view.type !== 'all' ? view.type : 'webtoon');
  $('f-status').value = work?.status || 'reading';
  $('f-author').value = work?.author || '';
  $('f-platform').value = work?.platform || '';
  $('f-review').value = work?.review || '';
  $('f-started').value = work?.startedAt || '';
  $('f-finished').value = work?.finishedAt || '';
  $('coverUrl').value = work?.cover && !work.cover.startsWith('data:') ? work.cover : '';
  $('coverFile').value = '';

  setFormCover(work?.cover || '');
  setFormRating(work?.rating || 0);
  $('editor').showModal();
  if (!work) $('f-title').focus();
}

function setFormCover(src) {
  formCover = src;
  $('coverPreview').innerHTML = src
    ? `<img src="${esc(src)}" alt="표지 미리보기" onerror="this.parentElement.innerHTML='<span>불러오기 실패</span>'">`
    : '<span>표지 없음</span>';
}

function setFormRating(value) {
  formRating = value;
  $('ratingStars').innerHTML = starsHTML(value);
  $('ratingValue').textContent = value ? value.toFixed(1) : '-';
}

async function handleSubmit(e) {
  e.preventDefault();
  const now = Date.now();
  const old = works.find((w) => w.id === editingId);

  const work = {
    id: old?.id || newId(),
    title: $('f-title').value.trim(),
    type: $('f-type').value,
    status: $('f-status').value,
    author: $('f-author').value.trim(),
    platform: $('f-platform').value.trim(),
    review: $('f-review').value.trim(),
    rating: formRating,
    cover: formCover,
    startedAt: $('f-started').value,
    finishedAt: $('f-finished').value,
    createdAt: old?.createdAt || now,
    updatedAt: now,
  };
  if (!work.title) return;

  // '완독'으로 바꾸고 다 본 날이 비어 있으면 오늘 날짜를 넣어줌
  if (work.status === 'done' && !work.finishedAt) {
    work.finishedAt = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD 형식
  }

  await saveOne(work);
  works = old ? works.map((w) => (w.id === work.id ? work : w)) : [...works, work];
  $('editor').close();
  render();
}

async function handleDelete() {
  const work = works.find((w) => w.id === editingId);
  if (!work || !confirm(`'${work.title}'을(를) 삭제할까요?`)) return;
  await deleteOne(work.id);
  works = works.filter((w) => w.id !== work.id);
  $('editor').close();
  render();
}


// ----- 6. 백업 / 복원 -----
function exportBackup() {
  const data = { app: 'my-library', version: 1, exportedAt: new Date().toISOString(), works };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `내서재-백업-${new Date().toLocaleDateString('sv-SE')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.works;
    if (!Array.isArray(list)) throw new Error('형식 오류');

    const valid = list.filter((w) => w && w.id && w.title && TYPES[w.type] && STATUSES[w.status]);
    if (!confirm(`백업 파일에서 ${valid.length}개 작품을 불러올게요.\n같은 작품이 이미 있으면 백업 내용으로 바뀌어요.`)) return;

    for (const w of valid) await saveOne(w);
    works = await loadAll();
    render();
    alert('복원이 끝났어요!');
  } catch (err) {
    alert('백업 파일을 읽을 수 없어요. 이 앱에서 만든 백업 파일이 맞는지 확인해 주세요.');
  }
}


// ----- 7. 버튼·입력에 동작 연결 -----
function bindEvents() {
  // 필터 & 정렬
  $('typeTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    view.type = btn.dataset.type;
    document.querySelectorAll('#typeTabs button').forEach((b) => b.classList.toggle('active', b === btn));
    render();
  });
  $('statusFilter').addEventListener('change', (e) => { view.status = e.target.value; render(); });
  $('sortSelect').addEventListener('change', (e) => { view.sort = e.target.value; render(); });
  $('search').addEventListener('input', (e) => { view.query = e.target.value; render(); });

  // 카드 누르면 수정 창 열기
  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) openEditor(works.find((w) => w.id === card.dataset.id));
  });
  $('addBtn').addEventListener('click', () => openEditor(null));

  // 입력 창
  $('workForm').addEventListener('submit', handleSubmit);
  $('cancelBtn').addEventListener('click', () => $('editor').close());
  $('deleteBtn').addEventListener('click', handleDelete);

  // 별점: 별의 왼쪽 절반을 누르면 .5점, 오른쪽 절반은 1점
  $('ratingStars').addEventListener('click', (e) => {
    const star = e.target.closest('.star');
    if (!star) return;
    const rect = star.getBoundingClientRect();
    const isLeftHalf = e.clientX - rect.left < rect.width / 2;
    setFormRating(Number(star.dataset.i) + (isLeftHalf ? 0.5 : 1));
  });
  $('ratingClear').addEventListener('click', () => setFormRating(0));

  // 표지
  $('coverFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      setFormCover(await resizeImage(file));
      $('coverUrl').value = '';
    } catch {
      alert('이미지를 불러올 수 없어요.');
    }
  });
  $('coverUrl').addEventListener('change', (e) => setFormCover(e.target.value.trim()));
  $('coverClear').addEventListener('click', () => {
    $('coverUrl').value = '';
    $('coverFile').value = '';
    setFormCover('');
  });

  // 백업 / 복원
  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });
}


// ----- 8. 앱 시작 -----
async function start() {
  bindEvents();
  try {
    db = await openDB();
    works = await loadAll();
  } catch (err) {
    alert('저장소를 열 수 없어요. 시크릿 모드라면 일반 창에서 열어 주세요.');
  }
  render();

  // 인터넷 주소(https)로 배포했을 때만: 앱 설치 & 오프라인 지원
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js');
  }
}

start();
