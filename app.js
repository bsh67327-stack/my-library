// =====================================================
// 내 서재 - 웹툰/웹소설/만화책 기록 앱
// =====================================================

// ----- 1. 기본 설정 -----
const TYPES = { webtoon: '웹툰', webnovel: '웹소설', comic: '만화책' };
const STATUSES = { reading: '보는 중', done: '완독', paused: '보류', dropped: '하차' };

// 앱 버전 (화면 맨 위 통계 줄 끝에 작게 표시 - index.html의 ?v= 숫자와 맞춰 주세요)
const APP_VERSION = 10;

// 작품 검색 중계 서버 주소 (Cloudflare Worker를 만든 뒤 여기에 붙여넣기)
const SEARCH_SERVER = 'https://my-library-search.bsh67327.workers.dev/';

// 화면 상태: 서재/캘린더 중 어떤 화면인지, 어떤 필터/정렬을 보고 있는지
const view = { mode: 'library', type: 'all', status: 'all', sort: 'updated', query: '' };

// 캘린더 상태: 보고 있는 연도/달(0=1월), 선택한 날짜('YYYY-MM-DD')
const now = new Date();
const cal = { year: now.getFullYear(), month: now.getMonth(), selected: null };

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

// 만화책은 '권', 웹툰/웹소설은 '화'
function unitOf(type) {
  return type === 'comic' ? '권' : '화';
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
  $('grid').innerHTML = list.map(cardHTML).join('');

  // (4) 비어 있을 때 안내 문구
  const empty = $('empty');
  empty.hidden = list.length > 0;
  empty.innerHTML = works.length === 0
    ? '아직 기록한 작품이 없어요.<br>오른쪽 아래 <b>＋</b> 버튼으로 첫 작품을 추가해 보세요!'
    : '조건에 맞는 작품이 없어요.';

  renderStats();
  if (view.mode === 'calendar') renderCalendar();
}

// 작품 카드 하나 (서재와 캘린더에서 같이 씀)
function cardHTML(w) {
  return `
    <article class="card" data-id="${esc(w.id)}">
      <div class="cover">
        <span class="cover-fallback">${esc(w.title)}</span>
        ${w.cover ? `<img src="${esc(w.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <div class="badges">
          <span class="badge">${TYPES[w.type]}</span>
          ${platformBadge(w.platform)}
        </div>
      </div>
      <div class="info">
        <div class="stars small">${starsHTML(w.rating)}</div>
        <h3 title="${esc(w.title)}">${esc(w.title)}</h3>
        <p class="author">${esc([w.author, w.platform].filter(Boolean).join(' · ') || ' ')}</p>
        <span class="status status-${w.status}">${STATUSES[w.status]}</span>
        ${progressHTML(w)}
        ${w.review ? `<p class="review">“${esc(w.review)}”</p>` : ''}
      </div>
    </article>`;
}

// 표지 왼쪽 위 플랫폼 표시 (플랫폼 이름에 들어간 글자로 판단)
const PLATFORM_BADGES = [
  { match: /네이버|naver/i, label: '네이버', cls: 'naver' },
  { match: /카카오|kakao/i, label: '카카오', cls: 'kakao' },
  { match: /리디|ridi/i, label: '리디', cls: 'ridi' },
  { match: /레진|lezhin/i, label: '레진', cls: 'lezhin' },
];

function platformBadge(platform) {
  const found = PLATFORM_BADGES.find((p) => p.match.test(platform || ''));
  return found ? `<span class="badge pf-${found.cls}">${found.label}</span>` : '';
}

// 카드의 "📖 32 / 189화" 줄과 "안 본 157화" 표시
function progressHTML(w) {
  if (!w.progress && !w.latest && w.status !== 'reading') return '';
  const unit = unitOf(w.type);
  const seen = w.progress || 0;
  const left = w.latest ? w.latest - seen : 0;
  return `
    <div class="progress">
      <span>📖 ${seen}${w.latest ? ` / ${w.latest}` : ''}${unit}${w.latestFinished ? ' 완결' : ''}</span>
      ${w.status === 'reading' ? `<button type="button" class="plus-btn" data-id="${esc(w.id)}">+1</button>` : ''}
    </div>
    ${w.status === 'reading' && left > 0 ? `<span class="new-badge">안 본 ${left}${unit}</span>` : ''}`;
}

function renderStats() {
  const done = works.filter((w) => w.status === 'done').length;
  const rated = works.filter((w) => w.rating > 0);
  const avg = rated.length ? (rated.reduce((s, w) => s + w.rating, 0) / rated.length).toFixed(1) : '-';
  $('stats').innerHTML = `전체 ${works.length}작품 · 완독 ${done} · 평균 평점 ★ ${avg}`
    + ` <small class="version">v${APP_VERSION}</small>`;
}


// ----- 4-2. 캘린더 화면 그리기 -----

// 시간(숫자) → 'YYYY-MM-DD' (내 폰 시간대 기준)
function dateKey(time) {
  return new Date(time).toLocaleDateString('sv-SE');
}

function renderCalendar() {
  const { year, month } = cal;
  const pad = (n) => String(n).padStart(2, '0');
  $('calTitle').textContent = `${year}년 ${month + 1}월`;

  // 작품을 추가한 날짜별로 묶기
  const byDay = {};
  for (const w of works) {
    const key = dateKey(w.createdAt);
    (byDay[key] = byDay[key] || []).push(w);
  }

  const startWeekday = new Date(year, month, 1).getDay(); // 1일이 무슨 요일인지 (0=일요일)
  const lastDate = new Date(year, month + 1, 0).getDate(); // 이번 달 마지막 날
  const today = dateKey(Date.now());
  let monthCount = 0;
  let html = '<div class="cal-cell blank"></div>'.repeat(startWeekday);

  for (let d = 1; d <= lastDate; d++) {
    const key = `${year}-${pad(month + 1)}-${pad(d)}`;
    const list = (byDay[key] || []).sort((a, b) => a.createdAt - b.createdAt);
    monthCount += list.length;
    const first = list[0];
    const classes = ['cal-cell', list.length && 'has', key === today && 'today', key === cal.selected && 'selected']
      .filter(Boolean).join(' ');
    html += `
      <button type="button" class="${classes}" data-date="${key}">
        <span class="cal-day">${d}</span>
        ${first ? `
          <span class="cal-fallback">${esc(first.title)}</span>
          ${first.cover ? `<img src="${esc(first.cover)}" alt="${esc(first.title)}" loading="lazy" onerror="this.remove()">` : ''}` : ''}
        ${list.length > 1 ? `<span class="cal-more">+${list.length - 1}</span>` : ''}
      </button>`;
  }
  $('calGrid').innerHTML = html;
  $('calSummary').textContent = monthCount
    ? `이번 달에 추가한 작품 ${monthCount}개`
    : '이번 달에 추가한 작품이 없어요';

  // 선택한 날짜의 작품 목록
  const picked = cal.selected && byDay[cal.selected];
  if (picked && cal.selected.startsWith(`${year}-${pad(month + 1)}`)) {
    const [, m, d] = cal.selected.split('-').map(Number);
    $('calDayList').innerHTML = `
      <h3 class="cal-day-title">${m}월 ${d}일에 추가한 작품 ${picked.length}개</h3>
      <div class="grid">${picked.map(cardHTML).join('')}</div>`;
  } else {
    $('calDayList').innerHTML = '';
  }
}

function moveMonth(diff) {
  const d = new Date(cal.year, cal.month + diff, 1);
  cal.year = d.getFullYear();
  cal.month = d.getMonth();
  cal.selected = null;
  renderCalendar();
}

// 서재 ↔ 캘린더 전환
function setViewMode(mode) {
  view.mode = mode;
  document.querySelectorAll('#viewTabs button')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
  $('libraryView').hidden = mode !== 'library';
  $('toolbar').hidden = mode !== 'library';
  $('calendarView').hidden = mode !== 'calendar';
  if (mode === 'calendar') {
    // 오늘 추가한 작품이 있으면 오늘을 선택해서 보여줌
    const today = dateKey(Date.now());
    if (!cal.selected && works.some((w) => dateKey(w.createdAt) === today)) cal.selected = today;
    renderCalendar();
  }
  window.scrollTo(0, 0);
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
  $('f-progress').value = work?.progress || '';
  formLink = work?.source
    ? { source: work.source, sourceId: work.sourceId, latest: work.latest, latestFinished: work.latestFinished }
    : null;
  updateProgressHint();
  $('f-started').value = work?.startedAt || '';
  $('f-finished').value = work?.finishedAt || '';
  $('coverUrl').value = work?.cover && !work.cover.startsWith('data:') ? work.cover : '';
  $('coverFile').value = '';

  setFormCover(work?.cover || '');
  setFormRating(work?.rating || 0);

  // 새 작품이면 검색창을 펼쳐서 보여줌
  $('searchBox').open = !work;
  $('s-query').value = '';
  $('s-results').innerHTML = '';
  $('editor').showModal();
  if (!work) $('s-query').focus();
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
    progress: Math.max(0, Math.floor(Number($('f-progress').value) || 0)),
    rating: formRating,
    cover: formCover,
    startedAt: $('f-started').value,
    finishedAt: $('f-finished').value,
    createdAt: old?.createdAt || now,
    updatedAt: now,
    // 플랫폼 연결 정보 (검색으로 추가한 작품만)
    source: formLink?.source || '',
    sourceId: formLink?.sourceId || '',
    latest: formLink?.latest || 0,
    latestFinished: !!formLink?.latestFinished,
    // 회차 수를 아직 모르면 0으로 둬서 다음에 앱을 열 때 바로 확인하게 함
    latestCheckedAt: formLink?.latest ? (old?.sourceId === formLink.sourceId ? old.latestCheckedAt : now) : 0,
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

// 카드의 +1 버튼: 수정 창을 열지 않고 바로 한 화 더하기
async function addProgress(id) {
  const old = works.find((w) => w.id === id);
  if (!old) return;
  const work = { ...old, progress: (old.progress || 0) + 1, updatedAt: Date.now() };
  await saveOne(work);
  works = works.map((w) => (w.id === id ? work : w));
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


// ----- 6. 플랫폼에서 작품 검색 -----

// 플랫폼마다 결과 모양이 달라서, 같은 모양으로 바꿔줌
// { sourceId(플랫폼의 작품 번호), title, author, cover, type, latest(현재 회차 수), finished(완결), note }

// 네이버 시리즈: 검색 결과 웹페이지에서 작품 정보를 꺼냄
// kind = 'novel'(웹소설) 또는 'comic'(만화 - 웹툰과 만화책이 섞여 있음)
function parseSeries(html, kind) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('.lst_list li')].map((li) => {
    const link = li.querySelector('h3 a[href*="productNo="]');
    if (!link) return null;
    // 제목 예: "화산귀환[독점] (총 189화/미완결)"
    const text = link.textContent.replace(/\s+/g, ' ').trim();
    const count = text.match(/\(총\s*([\d,]+)\s*(화|권)\s*\/\s*(미완결|완결)\)/);
    const unit = count ? count[2] : '';
    const img = li.querySelector('img');
    return {
      sourceId: link.getAttribute('href').match(/productNo=(\d+)/)[1],
      title: text.replace(/\s*\(총[^)]*\)\s*$/, '').replace(/\s*\[독점\]/, '').trim(),
      author: [...li.querySelectorAll('.author')].map((a) => a.textContent.trim()).join(', '),
      cover: img ? img.getAttribute('src').replace(/\?type=.*$/, '?type=m260') : '',
      type: kind === 'novel' ? 'webnovel' : unit === '권' ? 'comic' : 'webtoon',
      latest: count ? Number(count[1].replace(/,/g, '')) : 0,
      finished: count ? count[3] === '완결' : false,
      note: kind === 'novel' ? '웹소설' : unit === '권' ? '만화책' : '웹툰',
    };
  }).filter(Boolean);
}

const seriesSource = (kind) => ({
  platform: '네이버 시리즈',
  format: 'html',
  parse: (html) => parseSeries(html, kind),
  hasMore: (html, page, items) => items.length >= 25, // 한 페이지에 25개씩
});

// 네이버웹툰 / 베스트도전 / 도전만화는 결과 모양이 같아서 하나로 처리
const naverSource = (platform) => ({
  platform,
  parse: (data) => (data.searchList || []).map((w) => ({
    sourceId: w.titleId,
    title: w.titleName,
    author: w.displayAuthor,
    cover: w.thumbnailUrl,
    type: 'webtoon',
    latest: w.articleTotalCount || 0,
    finished: !!w.finished,
    note: '',
  })),
  hasMore: (data, page) => page + 1 < (data.pageInfo?.totalPages || 0),
});

const SEARCH_SOURCES = {
  naverWebtoon: naverSource('네이버웹툰'),
  naverBest: naverSource('네이버 베스트도전'),
  naverChallenge: naverSource('네이버 도전만화'),
  seriesNovel: seriesSource('novel'),
  seriesComic: seriesSource('comic'),
  kakaoWebtoon: {
    platform: '카카오웹툰',
    parse: (data) => (data.data?.content || []).map((c) => ({
      sourceId: c.id,
      title: c.title,
      author: (c.authors || []).filter((a) => a.type !== 'PUBLISHER').map((a) => a.name).join(', '),
      // 검색 목록에서는 캐릭터 그림 + 배경색으로 보여주고, 고르면 대표 이미지로 바꿈
      cover: c.featuredCharacterImageA ? `${c.featuredCharacterImageA}.png` : '',
      coverBg: c.backgroundColor || '',
      type: 'webtoon',
      latest: 0,
      finished: false,
      note: c.genre || '',
    })),
    hasMore: (data) => data.meta?.pagination ? !data.meta.pagination.last : false,
    // 작품 정보(대표 이미지)와 최신 회차를 함께 불러옴
    fetchLatest: async (id) => {
      const [info, episodes] = await Promise.all([
        callServer('kakaoWebtoonInfo', String(id)),
        callServer('kakaoWebtoonEpisodes', String(id)),
      ]);
      const share = info.data?.sharingThumbnailImage;
      return {
        latest: episodes.data?.episodes?.[0]?.no || 0,
        finished: false,
        cover: share ? `${share}.jpg` : '',
      };
    },
  },
  ridi: {
    platform: '리디',
    parse: (data) => (data.books || []).map((b) => {
      const category = `${b.parent_category_name || ''} ${b.category_name || ''}`;
      return {
        sourceId: b.b_id,
        title: b.title,
        author: b.author,
        cover: `https://img.ridicdn.net/cover/${b.b_id}/large`,
        type: /웹툰/.test(category) ? 'webtoon' : /만화|코믹/.test(category) ? 'comic' : 'webnovel',
        latest: b.book_count || 0,
        finished: !!b.is_series_complete,
        note: b.parent_category_name || b.category_name || '',
      };
    }),
    hasMore: (data, page) => (page + 1) * 24 < (data.total || 0),
  },
  kakao: {
    platform: '카카오페이지',
    parse: (data) => (data.result?.list || []).map((s) => ({
      sourceId: s.series_id,
      title: s.title,
      author: s.authors,
      cover: `https://page-images.kakaoentcdn.com/download/resource?kid=${s.thumbnail}&filename=th3`,
      type: s.operator_property?.is_manga ? 'comic' : s.category === '웹툰' ? 'webtoon' : 'webnovel',
      latest: 0, // 검색 결과에는 회차 수가 없어서 fetchLatest로 따로 불러옴
      finished: false,
      note: s.category || '',
    })),
    hasMore: (data) => data.result ? !data.result.is_end : false,
    fetchLatest: async (id) => {
      const data = await callServer('kakaoSeries', String(id));
      return { latest: data.result?.content?.on_sale_count || 0, finished: false };
    },
  },
};

// 검색 서버에 요청 보내기 (page는 0부터 시작, asText = 결과를 글자 그대로 받기)
async function callServer(source, q, page = 0, asText = false) {
  const res = await fetch(`${SEARCH_SERVER}?source=${source}&q=${encodeURIComponent(q.slice(0, 50))}&page=${page}`);
  if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
  return asText ? res.text() : res.json();
}

// 검색해서 { items: 같은 모양으로 바꾼 결과, hasMore: 다음 페이지가 있는지 } 돌려줌
async function fetchSearch(sourceKey, q, page = 0) {
  const src = SEARCH_SOURCES[sourceKey];
  const data = await callServer(sourceKey, q, page, src.format === 'html');
  const items = src.parse(data);
  return { items, hasMore: src.hasMore(data, page, items) };
}

// 저장된 작품의 최신 회차 확인
// (작품 번호로 바로 확인할 수 있으면 그걸로, 아니면 제목으로 다시 검색해서 같은 번호를 찾음)
async function fetchLatestInfo(work) {
  const src = SEARCH_SOURCES[work.source];
  if (src.fetchLatest) return src.fetchLatest(work.sourceId);
  const found = (await fetchSearch(work.source, work.title)).items
    .find((r) => String(r.sourceId) === String(work.sourceId));
  return found ? { latest: found.latest, finished: found.finished } : null;
}

let searchResults = [];
// 지금 보고 있는 검색 (더 보기 할 때 사용)
let searchState = { source: '', q: '', page: 0, hasMore: false, loading: false };
let formLink = null; // 입력 중인 작품이 연결된 플랫폼 정보 { source, sourceId, latest, latestFinished }

// 새로 검색 (more = true면 다음 페이지를 이어서 불러옴)
async function searchPlatform(more = false) {
  const box = $('s-results');
  if (!SEARCH_SERVER) {
    box.innerHTML = '<p class="msg">검색 서버가 아직 연결되지 않았어요. (app.js의 SEARCH_SERVER)</p>';
    return;
  }
  if (searchState.loading) return;

  if (!more) {
    const q = $('s-query').value.trim();
    if (!q) return;
    searchState = { source: $('s-source').value, q, page: 0, hasMore: false, loading: false };
    searchResults = [];
    box.innerHTML = '<p class="msg">검색 중…</p>';
  } else {
    searchState.page += 1;
    const btn = $('s-more');
    if (btn) { btn.disabled = true; btn.textContent = '불러오는 중…'; }
  }

  const { source, q, page } = searchState;
  searchState.loading = true;
  try {
    const result = await fetchSearch(source, q, page);
    searchResults = searchResults.concat(result.items.map((r) => ({ ...r, source })));
    searchState.hasMore = result.hasMore && result.items.length > 0;
  } catch (err) {
    if (more) searchState.page -= 1; // 실패하면 다음에 같은 페이지를 다시 시도
    // 원인을 같이 보여줘서 문제를 찾기 쉽게 함
    const msg = `<p class="msg">검색에 실패했어요. 잠시 후 다시 해보세요.<br><small>(${esc(source)}: ${esc(err.message || err)})</small></p>`;
    if (more) {
      renderSearchResults();
      box.insertAdjacentHTML('beforeend', msg);
    } else {
      box.innerHTML = msg;
    }
    return;
  } finally {
    searchState.loading = false;
  }
  renderSearchResults();
}

function renderSearchResults() {
  const box = $('s-results');
  if (!searchResults.length) {
    box.innerHTML = '<p class="msg">검색 결과가 없어요.</p>';
    return;
  }
  box.innerHTML = searchResults.map((r, i) => {
    const count = r.latest ? `${r.latest}${unitOf(r.type)}${r.finished ? ' 완결' : ''}` : '';
    return `
      <button type="button" class="s-item" data-i="${i}">
        <img src="${esc(r.cover)}" alt="" loading="lazy"${/^#[0-9a-f]{3,8}$/i.test(r.coverBg || '') ? ` style="background:${r.coverBg}"` : ''}>
        <span><b>${esc(r.title)}</b><small>${esc([r.author, r.note, count].filter(Boolean).join(' · '))}</small></span>
      </button>`;
  }).join('') + (searchState.hasMore
    ? `<button type="button" id="s-more" class="ghost s-more">더 보기 (지금 ${searchResults.length}개)</button>`
    : `<p class="msg">검색 결과 ${searchResults.length}개를 모두 봤어요.</p>`);
}

// 검색 결과를 누르면 입력칸을 자동으로 채움
function pickResult(r) {
  $('f-title').value = r.title;
  $('f-author').value = r.author || '';
  $('f-type').value = r.type;
  $('f-platform').value = SEARCH_SOURCES[r.source].platform;
  $('coverUrl').value = r.cover;
  setFormCover(r.cover);
  const link = { source: r.source, sourceId: r.sourceId, latest: r.latest, latestFinished: r.finished };
  formLink = link;
  updateProgressHint();

  // 카카오페이지처럼 검색 결과에 회차 수가 없으면 따로 불러옴
  const src = SEARCH_SOURCES[r.source];
  if (src.fetchLatest) {
    src.fetchLatest(r.sourceId).then((info) => {
      if (formLink !== link) return; // 그사이 다른 작품을 골랐으면 무시
      link.latest = info.latest;
      link.latestFinished = info.finished;
      updateProgressHint();
      // 카카오웹툰처럼 더 좋은 대표 이미지가 있으면 표지를 바꿈
      if (info.cover) {
        $('coverUrl').value = info.cover;
        setFormCover(info.cover);
      }
    }).catch(() => {});
  }
  $('searchBox').open = false;
  $('s-results').innerHTML = '';
}

// "어디까지 봤나요?" 칸 그리기
// 최신 회차를 알면 1화~최신화 목록에서 고르고, 모르면 숫자 입력칸을 보여줌
// (실제 값은 항상 숫자 입력칸 f-progress에 저장됨 - 목록은 그걸 보여주는 역할)
function updateProgressHint() {
  const unit = unitOf($('f-type').value);
  const latest = formLink?.latest || 0;
  const current = Math.max(0, Math.floor(Number($('f-progress').value) || 0));
  const select = $('f-progress-select');
  const useList = latest > 0;

  select.hidden = !useList;
  $('f-progress').hidden = useList;
  $('progressSuffix').hidden = useList;
  $('progressUnit').textContent = unit;

  if (useList) {
    const max = Math.max(latest, current);
    let options = '<option value="0">아직 안 봄</option>';
    for (let i = 1; i <= max; i++) {
      options += `<option value="${i}">${i}${unit}까지${i === latest ? ' (최신)' : ''}</option>`;
    }
    select.innerHTML = options;
    select.value = String(current);
  }

  $('latestInfo').textContent = latest
    ? `현재 ${latest}${unit}${formLink.latestFinished ? ' 완결' : ''}`
    : '';
}


// ----- 7. 최신 회차 자동 확인 -----
// 보는 중/보류인 작품을 플랫폼에서 다시 검색해서 회차 수를 갱신
const REFRESH_INTERVAL = 3 * 60 * 60 * 1000; // 같은 작품은 3시간에 한 번만 확인
let refreshing = false;

async function refreshLatest() {
  if (!SEARCH_SERVER || refreshing) return;
  refreshing = true;
  const targets = works.filter((w) =>
    w.source && SEARCH_SOURCES[w.source] && w.sourceId &&
    (w.status === 'reading' || w.status === 'paused') &&
    Date.now() - (w.latestCheckedAt || 0) > REFRESH_INTERVAL
  );

  for (const target of targets.slice(0, 30)) {
    try {
      const found = await fetchLatestInfo(target);
      if (!found) continue;
      // 그사이 사용자가 고쳤을 수 있으니 가장 최신 기록을 기준으로 회차 정보만 바꿈
      const current = works.find((w) => w.id === target.id);
      if (!current) continue;
      const updated = { ...current, latest: found.latest, latestFinished: found.finished, latestCheckedAt: Date.now() };
      await saveOne(updated);
      works = works.map((w) => (w.id === updated.id ? updated : w));
    } catch {
      // 실패하면 다음에 다시 시도
    }
  }
  refreshing = false;
  if (targets.length) render();
}


// ----- 8. 백업 / 복원 -----
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


// ----- 9. 버튼·입력에 동작 연결 -----
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
  const onCardClick = (e) => {
    const plus = e.target.closest('.plus-btn');
    if (plus) { addProgress(plus.dataset.id); return; }
    const card = e.target.closest('.card');
    if (card) openEditor(works.find((w) => w.id === card.dataset.id));
  };
  $('grid').addEventListener('click', onCardClick);
  $('calDayList').addEventListener('click', onCardClick);

  // 서재 / 캘린더 전환
  $('viewTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) setViewMode(btn.dataset.view);
  });

  // 캘린더: 날짜 누르면 그날 작품 보기 (한 번 더 누르면 닫기)
  $('calGrid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell.has');
    if (!cell) return;
    cal.selected = cal.selected === cell.dataset.date ? null : cell.dataset.date;
    renderCalendar();
    if (cal.selected) $('calDayList').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('calPrev').addEventListener('click', () => moveMonth(-1));
  $('calNext').addEventListener('click', () => moveMonth(1));

  // 캘린더: 좌우로 밀어서 달 넘기기
  let touchX = null;
  $('calGrid').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  $('calGrid').addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 60) moveMonth(dx < 0 ? 1 : -1);
  });
  $('addBtn').addEventListener('click', () => openEditor(null));

  // 입력 창
  $('workForm').addEventListener('submit', handleSubmit);
  $('f-type').addEventListener('change', updateProgressHint);
  $('f-progress-select').addEventListener('change', (e) => {
    $('f-progress').value = e.target.value;
  });
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

  // 플랫폼 검색 (엔터를 눌러도 저장되지 않고 검색되도록)
  $('s-btn').addEventListener('click', () => searchPlatform());
  $('s-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchPlatform(); }
  });
  $('s-results').addEventListener('click', (e) => {
    if (e.target.closest('#s-more')) { searchPlatform(true); return; }
    const item = e.target.closest('.s-item');
    if (item) pickResult(searchResults[item.dataset.i]);
  });

  // 백업 / 복원
  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });
}


// ----- 10. 앱 시작 -----
async function start() {
  bindEvents();
  try {
    db = await openDB();
    works = await loadAll();
  } catch (err) {
    alert('저장소를 열 수 없어요. 시크릿 모드라면 일반 창에서 열어 주세요.');
  }
  render();

  // 최신 회차 확인: 앱을 열 때 + 다른 앱 갔다가 돌아올 때
  refreshLatest();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLatest();
  });

  // 인터넷 주소(https)로 배포했을 때만: 앱 설치 & 오프라인 지원
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js');
  }
}

start();
