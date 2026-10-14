// =====================================================
// 툰앤소 - 웹툰/웹소설/만화책 기록 앱
// =====================================================

// ----- 1. 기본 설정 -----
const TYPES = { webtoon: '웹툰', webnovel: '웹소설', comic: '만화책', manga: '일본만화' };
const STATUSES = { reading: '보는 중', done: '완독', paused: '보류', dropped: '하차' };

// 앱 버전 (홈 화면 제목 옆에 작게 표시 - index.html의 ?v= 숫자와 맞춰 주세요)
const APP_VERSION = 18;

// 작품 검색 중계 서버 주소 (Cloudflare Worker를 만든 뒤 여기에 붙여넣기)
const SEARCH_SERVER = 'https://my-library-search.bsh67327.workers.dev/';

// 화면 상태: 홈/서재/캘린더 중 어떤 화면인지, 어떤 필터/정렬을 보고 있는지
// layout: 서재를 쌓아보기(stack)로 볼지 리스트(list)로 볼지 (마지막에 고른 것을 기억)
const view = { mode: 'home', layout: savedLayout(), type: 'all', status: 'all', sort: 'updated', query: '' };

function savedLayout() {
  try { return localStorage.getItem('layout') === 'list' ? 'list' : 'stack'; } catch { return 'stack'; }
}

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

// 회차 단위: 플랫폼이 알려준 단위(unit)가 있으면 그걸 쓰고, 없으면 만화책은 '권', 나머지는 '화'
function unitOf(type, unit) {
  return unit || (type === 'comic' ? '권' : '화');
}

// 작가 이름이 모두 "Koyoharu Gotouge"처럼 두 단어 이상의 영문이면 일본 만화로 추정
// ("SIU", "ARCHE"처럼 한 단어 영문 필명은 한국 웹툰에도 많아서 제외)
function looksJapaneseAuthor(names) {
  return names.length > 0 && names.every((n) => /^[A-Za-z.'\-]+( [A-Za-z.'\-]+)+$/.test(n.trim()));
}

// http(s)로 시작하는 주소만 링크로 씀 (이상한 주소가 실행되지 않게)
function safeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? url : '';
}

// 플랫폼의 작품 번호로 원래 작품 페이지 주소 만들기
// (주소를 따로 저장하지 않은 예전 작품도 링크가 생기게 함)
const PLATFORM_LINKS = {
  naverWebtoon: (id) => `https://comic.naver.com/webtoon/list?titleId=${id}`,
  naverBest: (id) => `https://comic.naver.com/bestChallenge/list?titleId=${id}`,
  naverChallenge: (id) => `https://comic.naver.com/challenge/list?titleId=${id}`,
  seriesNovel: (id) => `https://series.naver.com/novel/detail.series?productNo=${id}`,
  seriesComic: (id) => `https://series.naver.com/comic/detail.series?productNo=${id}`,
  kakao: (id) => `https://page.kakao.com/content/${id}`,
  ridi: (id) => `https://ridibooks.com/books/${id}`,
};

function linkOf(source, sourceId) {
  const make = PLATFORM_LINKS[source];
  return make && sourceId ? make(encodeURIComponent(sourceId)) : '';
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

  // (3) 쌓아보기 / 리스트로 그리기
  $('libCount').textContent = list.length || '';
  $('grid').className = `layout-${view.layout}`;
  $('grid').innerHTML = view.layout === 'stack'
    ? (list.length ? `<div class="stack">${list.map(spineHTML).join('')}</div>` : '')
    : list.map(rowHTML).join('');
  document.querySelectorAll('#layoutToggle button')
    .forEach((b) => b.classList.toggle('active', b.dataset.layout === view.layout));

  // (4) 비어 있을 때 안내 문구
  const empty = $('empty');
  empty.hidden = list.length > 0;
  empty.innerHTML = works.length === 0
    ? '아직 기록한 작품이 없어요.<br>오른쪽 아래 <b>＋</b> 버튼으로 첫 작품을 추가해 보세요!'
    : '조건에 맞는 작품이 없어요.';

  renderStats();
  renderHome();
  renderFeed();
  if (view.mode === 'calendar') renderCalendar();
}

// 표지 (사진이 없거나 못 불러오면 제목 글자로 대신)
function coverHTML(w, cls) {
  return `
    <div class="${cls}">
      <span class="cover-fallback">${esc(w.title)}</span>
      ${w.cover ? `<img src="${esc(w.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    </div>`;
}

// 리스트 한 줄 (서재 리스트, 홈 최근 기록, 캘린더에서 같이 씀)
function rowHTML(w) {
  return `
    <article class="card item" data-id="${esc(w.id)}">
      ${coverHTML(w, 'thumb')}
      <div class="item-body">
        <p class="kicker">${esc([TYPES[w.type], w.platform].filter(Boolean).join(' · '))}</p>
        <h3>${esc(w.title)}</h3>
        ${w.author ? `<p class="author">${esc(w.author)}</p>` : ''}
        <div class="item-meta">
          <span class="stars small">${starsHTML(w.rating)}</span>
          ${w.rating ? `<b class="rating-num">${w.rating.toFixed(1)}</b>` : ''}
          <span class="status status-${w.status}">${STATUSES[w.status]}</span>
        </div>
        ${progressHTML(w)}
        ${w.review ? `<p class="review">${esc(w.review)}</p>` : ''}
        ${linksHTML(w)}
      </div>
    </article>`;
}

// 쌓아보기: 작품을 책등처럼 쌓음
// 많이 본 작품일수록 두껍게, 폭·위치·기울기는 작품마다 조금씩 다르게 (작품 id로 정해서 매번 같음)
const SPINE_COLORS = ['#e07a5f', '#3d405b', '#81b29a', '#b56576', '#355070', '#6d597a', '#457b9d', '#2a9d8f', '#bc6c25', '#588157'];

function hashOf(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function spineHTML(w) {
  const h = hashOf(w.id);
  const thick = 36 + Math.min(22, Math.round(Math.log2((w.progress || 0) + 1) * 2.2));
  const width = 74 + (h % 23);              // 74~96%
  const shift = ((h >> 5) % 17) - 8;        // 왼쪽/오른쪽으로 -8~8px
  const tilt = (((h >> 9) % 9) - 4) / 10;   // -0.4~0.4도
  return `
    <article class="card spine" data-id="${esc(w.id)}"
      style="--h:${thick}px;--w:${width}%;--x:${shift}px;--r:${tilt}deg;--c:${SPINE_COLORS[h % SPINE_COLORS.length]}">
      ${w.cover ? `<img src="${esc(w.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <span class="spine-type">${TYPES[w.type]}</span>
      <span class="spine-title">${esc(w.title)}</span>
      ${w.rating ? `<span class="spine-rating">★ ${w.rating.toFixed(1)}</span>` : ''}
    </article>`;
}

// 홈 "보는 중" 가로 목록의 작품 하나
function miniHTML(w) {
  const unit = unitOf(w.type, w.unit);
  const seen = w.progress || 0;
  const left = w.latest ? w.latest - seen : 0;
  return `
    <article class="card mini" data-id="${esc(w.id)}">
      <div class="mini-cover">
        ${coverHTML(w, 'cover')}
        ${left > 0 ? `<span class="left-badge">안 본 ${left}${unit}</span>` : ''}
      </div>
      <h3>${esc(w.title)}</h3>
      ${w.latest ? `<span class="bar"><i style="width:${Math.min(100, (seen / w.latest) * 100)}%"></i></span>` : ''}
      <div class="mini-foot">
        <span>${seen}${w.latest ? ` / ${w.latest}` : ''}${unit}</span>
        <button type="button" class="plus-btn" data-id="${esc(w.id)}">+1</button>
      </div>
    </article>`;
}

// 카드의 "네이버웹툰 ↗ 카카오페이지 ↗" 링크 (누르면 원래 플랫폼으로 이동)
function linksHTML(w) {
  const links = workLinks(w);
  if (!links.length) return '';
  return `<div class="go-links">${links.map((l) =>
    `<a class="go-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)} ↗</a>`).join('')}</div>`;
}

// 리스트의 진행 막대 + "32 / 189화 · 안 본 157화" + +1 버튼 (최신 회차는 직접 입력한 값)
function progressHTML(w) {
  if (!w.progress && !w.latest && w.status !== 'reading') return '';
  const unit = unitOf(w.type, w.unit);
  const seen = w.progress || 0;
  const left = w.latest ? w.latest - seen : 0;
  return `
    <div class="progress">
      ${w.latest ? `<span class="bar"><i style="width:${Math.min(100, (seen / w.latest) * 100)}%"></i></span>` : ''}
      <span class="progress-text">${seen}${w.latest ? ` / ${w.latest}` : ''}${unit}${w.status === 'reading' && left > 0 ? ` <em>· 안 본 ${left}${unit}</em>` : ''}</span>
      ${w.status === 'reading' ? `<button type="button" class="plus-btn" data-id="${esc(w.id)}">+1</button>` : ''}
    </div>`;
}

function renderStats() {
  const count = (status) => works.filter((w) => w.status === status).length;
  const rated = works.filter((w) => w.rating > 0);
  const avg = rated.length ? (rated.reduce((s, w) => s + w.rating, 0) / rated.length).toFixed(1) : '-';
  const tiles = [['전체', works.length], ['보는 중', count('reading')], ['완독', count('done')], ['평균 평점', avg]];
  $('stats').innerHTML = tiles.map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('');
  $('appVersion').textContent = `v${APP_VERSION}`;
}

// 홈: 보는 중인 작품(가로 목록) + 추천 + 최근에 기록한 작품 5개
function renderHome() {
  const byUpdated = [...works].sort((a, b) => b.updatedAt - a.updatedAt);
  const reading = byUpdated.filter((w) => w.status === 'reading');
  $('readingCount').textContent = reading.length || '';
  $('readingRow').innerHTML = reading.length
    ? reading.map(miniHTML).join('')
    : '<p class="hint">보는 중인 작품이 없어요.</p>';
  const recs = recommendations();
  $('recSection').hidden = recs.length === 0;
  $('recRow').innerHTML = recs.map(recHTML).join('');
  $('recentList').innerHTML = works.length
    ? byUpdated.slice(0, 5).map(rowHTML).join('')
    : '<p class="hint">아직 기록한 작품이 없어요.<br>위 검색창에서 첫 작품을 추가해 보세요!</p>';
}

// 홈 "이런 건 어때요?": 내 서재 기록만으로 고른 추천 (밖으로 요청을 보내지 않음)
const DAY = 24 * 60 * 60 * 1000;

function recommendations() {
  const recs = [];
  const oldestFirst = (a, b) => a.updatedAt - b.updatedAt;

  // (1) 평점을 높게 준 작품의 작가 → 누르면 그 작가 이름으로 플랫폼 검색 (작가당 한 번, 최대 3명)
  const authors = new Set();
  works.filter((w) => w.rating >= 4.5 && w.author)
    .sort((a, b) => b.rating - a.rating || b.updatedAt - a.updatedAt)
    .forEach((w) => {
      const name = w.author.split(/[,/·]/)[0].trim();
      if (!name || authors.has(name) || authors.size >= 3) return;
      authors.add(name);
      recs.push({ w, reason: `재밌게 본 「${w.title}」 작가`, author: name });
    });

  // (2) 보류해 둔 작품, (3) 2주 넘게 기록이 없는 보는 중 작품, (4) 한 달 넘게 안 연 인생작(4.5점 이상 완독)
  const picks = [
    [(w) => w.status === 'paused', '보류했던 작품, 다시 볼까요?', 3],
    [(w) => w.status === 'reading' && Date.now() - w.updatedAt > 14 * DAY, '요즘 안 보셨어요', 2],
    [(w) => w.status === 'done' && w.rating >= 4.5 && Date.now() - w.updatedAt > 30 * DAY, '인생작 다시 보기', 2],
  ];
  const used = new Set();
  for (const [match, reason, max] of picks) {
    works.filter((w) => match(w) && !used.has(w.id)).sort(oldestFirst).slice(0, max).forEach((w) => {
      used.add(w.id);
      recs.push({ w, reason });
    });
  }
  return recs;
}

function recHTML({ w, reason, author }) {
  const target = author ? `class="rec" data-author="${esc(author)}"` : `class="card rec" data-id="${esc(w.id)}"`;
  return `
    <article ${target}>
      <div class="mini-cover">
        ${coverHTML(w, 'cover')}
        ${author ? '<span class="rec-search">찾아보기</span>' : ''}
      </div>
      <p class="rec-reason">${esc(reason)}</p>
      <h3>${esc(author ? `${author} 작가의 다른 작품` : w.title)}</h3>
    </article>`;
}

// 피드: 한줄평을 남긴 작품을 최근 순으로 (나중에 다른 사람 한줄평도 이 모양으로)
function renderFeed() {
  const posts = works.filter((w) => w.review).sort((a, b) => b.updatedAt - a.updatedAt);
  $('feedList').innerHTML = posts.length
    ? posts.map(feedHTML).join('')
    : '<p class="hint">작품에 한줄평을 남기면 여기에 쌓여요.</p>';
}

function feedHTML(w) {
  return `
    <article class="card post" data-id="${esc(w.id)}">
      <div class="post-head">
        <span class="avatar"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="9" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6z"/></svg></span>
        <b>나</b>
        <span class="post-time">${timeAgo(w.updatedAt)}</span>
        <span class="status status-${w.status}">${STATUSES[w.status]}</span>
      </div>
      <p class="post-text">${esc(w.review)}</p>
      <div class="post-work">
        ${coverHTML(w, 'thumb')}
        <div class="item-body">
          <p class="kicker">${esc([TYPES[w.type], w.platform].filter(Boolean).join(' · '))}</p>
          <h3>${esc(w.title)}</h3>
          <span class="stars small">${starsHTML(w.rating)}</span>
        </div>
      </div>
    </article>`;
}

// "방금 / 5분 전 / 3시간 전 / 2일 전 / 2026. 9. 1."
function timeAgo(time) {
  const min = Math.floor((Date.now() - time) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간 전`;
  if (min < 60 * 24 * 7) return `${Math.floor(min / 60 / 24)}일 전`;
  return new Date(time).toLocaleDateString('ko-KR');
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
    // 날짜 아래에 그날 추가한 작품 표지 (여러 개면 뒤에 한 장 더 겹쳐 보이고 +N 표시)
    html += `
      <button type="button" class="${classes}" data-date="${key}">
        <span class="cal-day">${d}</span>
        ${first ? `
          <span class="cal-cover${list.length > 1 ? ' multi' : ''}">
            <span class="cal-fallback">${esc(first.title)}</span>
            ${first.cover ? `<img src="${esc(first.cover)}" alt="${esc(first.title)}" loading="lazy" onerror="this.remove()">` : ''}
            ${list.length > 1 ? `<span class="cal-more">+${list.length - 1}</span>` : ''}
          </span>` : ''}
      </button>`;
  }
  $('calGrid').innerHTML = html;
  $('calSummary').innerHTML = monthCount
    ? `이번 달에 <b>${monthCount}작품</b>을 기록했어요`
    : '이번 달에 기록한 작품이 없어요';

  // 선택한 날짜의 작품 목록
  const picked = cal.selected && byDay[cal.selected];
  if (picked && cal.selected.startsWith(`${year}-${pad(month + 1)}`)) {
    const [, m, d] = cal.selected.split('-').map(Number);
    $('calDayList').innerHTML = `
      <h3 class="cal-day-title">${m}월 ${d}일에 추가한 작품 ${picked.length}개</h3>
      <div class="list">${picked.map(rowHTML).join('')}</div>`;
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

// 홈 / 서재 / 피드 / 캘린더 전환 (아래 탭바)
function setViewMode(mode) {
  view.mode = mode;
  document.querySelectorAll('#viewTabs button')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
  $('homeView').hidden = mode !== 'home';
  $('libraryView').hidden = mode !== 'library';
  $('feedView').hidden = mode !== 'feed';
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
  $('f-latest').value = work?.latest || '';
  $('f-url').value = '';
  formLinks = work ? workLinks(work).map((l) => ({ ...l })) : [];
  renderLinkList();
  formLink = work?.source ? { source: work.source, sourceId: work.sourceId, unit: work.unit } : null;
  updateProgressUnit();
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
    latest: Math.max(0, Math.floor(Number($('f-latest').value) || 0)), // 직접 입력한 최신 회차
    links: formLinks.map(({ name, url }) => ({ name, url })), // 보러 갈 곳 (플랫폼 링크)
    rating: formRating,
    cover: formCover,
    startedAt: $('f-started').value,
    finishedAt: $('f-finished').value,
    createdAt: old?.createdAt || now,
    updatedAt: now,
    // 플랫폼 연결 정보 (검색으로 추가한 작품만)
    source: formLink?.source || '',
    sourceId: formLink?.sourceId || '',
    unit: formLink?.unit || '',
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
// { sourceId(플랫폼의 작품 번호), title, author, cover, type, url(작품 페이지 주소, 번호로 못 만드는 곳만), note }
// 회차 수는 플랫폼에서 가져오지 않고 사용자가 직접 입력함

// 네이버 시리즈: 검색 결과 웹페이지에서 작품 정보를 꺼냄
// kind = 'novel'(웹소설) 또는 'comic'(만화 - 웹툰과 만화책이 섞여 있음)
function parseSeries(html, kind) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('.lst_list li')].map((li) => {
    const link = li.querySelector('h3 a[href*="productNo="]');
    if (!link) return null;
    // 제목 예: "화산귀환[독점] (총 189화/미완결)" - 회차 수는 버리고 단위(화/권)만 씀
    const text = link.textContent.replace(/\s+/g, ' ').trim();
    const count = text.match(/\(총\s*[\d,]+\s*(화|권)/);
    const unit = count ? count[1] : '';
    const img = li.querySelector('img');
    // 같은 이름이 두 번 나오는 경우가 많아서(글/그림 작가) 중복 제거
    const authors = [...new Set([...li.querySelectorAll('.author')].map((a) => a.textContent.trim()))];

    // 종류 판단: 웹소설 → 웹소설 / 작가가 영문 이름 → 일본만화 / 권 단위·[단행본] → 만화책 / 나머지 → 웹툰
    let type = 'webtoon';
    if (kind === 'novel') type = 'webnovel';
    else if (looksJapaneseAuthor(authors)) type = 'manga';
    else if (unit === '권' || /\[단행본\]/.test(text)) type = 'comic';

    return {
      sourceId: link.getAttribute('href').match(/productNo=(\d+)/)[1],
      title: text.replace(/\s*\(총[^)]*\)\s*$/, '').replace(/\s*\[독점\]/, '').trim(),
      author: authors.join(', '),
      cover: img ? img.getAttribute('src').replace(/\?type=.*$/, '?type=m260') : '',
      type,
      unit,
      note: TYPES[type],
    };
  }).filter(Boolean);
}

const seriesSource = (kind) => ({
  platform: '네이버 시리즈',
  format: 'html',
  parse: (html) => parseSeries(html, kind),
  hasMore: (html, page, items) => items.length >= 25, // 한 페이지에 25개씩
});

// 미스터블루: 검색 결과 웹페이지에서 작품 정보를 꺼냄
function parseMrblue(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 진짜 검색 결과는 #listBox 안에만 있음 (결과가 없으면 '추천 신작' 목록이 대신 나와서 그건 빼야 함)
  return [...doc.querySelectorAll('#listBox li[data-pid]')].map((li) => {
    const link = li.querySelector('.tit a');
    if (!link) return null;
    const category = li.querySelector('.label-category')?.textContent.trim() || ''; // 웹툰 / 만화 / 소설
    // 제목 링크 안에 [만화] 표시가 같이 있어서 글자 부분만 꺼냄
    const title = [...link.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
    const info = (li.querySelector('.info')?.textContent || '').replace(/\s+/g, ' '); // 예: "2026.10.01 730화 연재 대원씨아이"
    const count = info.match(/[\d,]+\s*(화|권)/); // 회차 수는 버리고 단위(화/권)만 씀
    const authors = [...new Set([...li.querySelectorAll('.authorname')].map((a) => a.textContent.trim()))];
    const img = li.querySelector('img');
    const href = link.getAttribute('href');
    return {
      sourceId: li.dataset.pid,
      title,
      author: authors.join(', '),
      cover: img ? (img.getAttribute('data-original') || img.getAttribute('src') || '') : '',
      type: category === '소설' ? 'webnovel' : category === '웹툰' ? 'webtoon' : 'comic',
      unit: count ? count[1] : '',
      url: href ? new URL(href, 'https://www.mrblue.com').href : '',
      note: category,
    };
  }).filter(Boolean);
}

// 네이버웹툰 / 베스트도전 / 도전만화는 결과 모양이 같아서 하나로 처리
const naverSource = (platform) => ({
  platform,
  parse: (data) => (data.searchList || []).map((w) => ({
    sourceId: w.titleId,
    title: w.titleName,
    author: w.displayAuthor,
    cover: w.thumbnailUrl,
    type: 'webtoon',
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
  mrblue: {
    platform: '미스터블루',
    format: 'html',
    parse: parseMrblue,
    hasMore: (html, page, items) => items.length >= 120, // 한 페이지에 120개씩
  },
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
      // 카카오웹툰 주소에는 작품 번호 말고 영문 이름(seoId)도 들어감
      url: c.seoId ? `https://webtoon.kakao.com/content/${encodeURIComponent(c.seoId)}/${c.id}` : '',
      note: c.genre || '',
    })),
    hasMore: (data) => data.meta?.pagination ? !data.meta.pagination.last : false,
    // 고른 작품의 대표 이미지를 불러옴
    fetchCover: async (id) => {
      const info = await callServer('kakaoWebtoonInfo', String(id));
      const share = info.data?.sharingThumbnailImage;
      return share ? `${share}.jpg` : '';
    },
  },
  // 리디는 검색 요청을 막고 있어서(403) 검색에서 뺌 - 리디 링크는 직접 추가할 수 있음
  kakao: {
    platform: '카카오페이지',
    parse: (data) => (data.result?.list || []).map((s) => ({
      sourceId: s.series_id,
      title: s.title,
      author: s.authors,
      cover: `https://page-images.kakaoentcdn.com/download/resource?kid=${s.thumbnail}&filename=th3`,
      // 카카오페이지가 일본 만화로 표시한 작품(is_manga)은 일본만화로
      type: s.operator_property?.is_manga ? 'manga' : s.category === '웹툰' ? 'webtoon' : 'webnovel',
      note: s.category || '',
    })),
    hasMore: (data) => data.result ? !data.result.is_end : false,
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

// ----- 6-2. 전체 검색 -----
// 검색창 하나로 모든 플랫폼을 한꺼번에 검색하고, 같은 작품은 하나로 묶어서 보여줌
// (앞에 있을수록 대표 정보(제목·작가·표지)로 먼저 쓰임 - 아마추어 연재인 베스트도전/도전만화는 맨 뒤)
const ALL_SOURCES = ['naverWebtoon', 'kakaoWebtoon', 'kakao', 'seriesNovel', 'seriesComic', 'mrblue', 'naverBest', 'naverChallenge'];
const sourceRank = (source) => ALL_SOURCES.indexOf(source);

// 같은 작품인지 비교하려고 제목에서 띄어쓰기·기호·[독점] 같은 표시를 뺌
function titleKey(title) {
  return String(title || '').toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/[^0-9a-z가-힣ぁ-んァ-ヶ一-龥]/g, '');
}

// 지금 보고 있는 검색
// groups: 묶은 작품들 (key → { key, items: 플랫폼별 결과, order: 처음 나온 순서 })
// pages: 플랫폼별로 몇 페이지까지 봤는지 / 더 있는지 (더 보기 할 때 사용)
let searchState = { q: '', groups: new Map(), pages: {}, failed: [], loading: false };
let formLink = null;  // 입력 중인 작품의 대표 플랫폼 정보 { source, sourceId, unit }
let formLinks = [];   // 입력 중인 작품의 "보러 갈 곳" 목록 [{ name, url }]

// 플랫폼 결과를 묶음에 넣기 (제목과 종류가 같으면 같은 작품으로 봄)
function addToGroups(source, items) {
  for (const item of items) {
    const key = `${titleKey(item.title) || `${source}:${item.sourceId}`}|${item.type}`;
    let group = searchState.groups.get(key);
    if (!group) {
      group = { key, items: [], order: searchState.groups.size };
      searchState.groups.set(key, group);
    }
    // 같은 플랫폼에서 같은 제목이 여러 개 나오면 첫 번째만 씀
    if (!group.items.some((i) => i.source === source)) group.items.push({ ...item, source });
  }
}

// 묶음의 대표 결과 (플랫폼 순서상 가장 앞)
function mainItem(group) {
  return [...group.items].sort((a, b) => sourceRank(a.source) - sourceRank(b.source))[0];
}

// 묶음의 표지: 카카오웹툰은 캐릭터 그림이라 다른 플랫폼 표지가 있으면 그걸 씀
function coverItem(group) {
  const withCover = [...group.items].filter((i) => i.cover)
    .sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
  return withCover.find((i) => i.source !== 'kakaoWebtoon') || withCover[0] || null;
}

// 새로 검색 (more = true면 다음 페이지가 있는 플랫폼만 이어서 불러옴)
async function searchPlatform(more = false) {
  const box = $('s-results');
  if (!SEARCH_SERVER) {
    box.innerHTML = '<p class="msg">검색 서버가 아직 연결되지 않았어요. (app.js의 SEARCH_SERVER)</p>';
    return;
  }
  if (searchState.loading) return;

  let targets;
  if (!more) {
    const q = $('s-query').value.trim();
    if (!q) return;
    searchState = { q, groups: new Map(), pages: {}, failed: [], loading: false };
    targets = ALL_SOURCES.map((source) => ({ source, page: 0 }));
    box.innerHTML = '<p class="msg">모든 플랫폼에서 찾는 중…</p>';
  } else {
    targets = Object.entries(searchState.pages)
      .filter(([, p]) => p.hasMore)
      .map(([source, p]) => ({ source, page: p.page + 1 }));
    const btn = $('s-more');
    if (btn) { btn.disabled = true; btn.textContent = '불러오는 중…'; }
  }

  searchState.loading = true;
  searchState.failed = [];
  const { q } = searchState;
  // 모든 플랫폼에 동시에 요청하고, 실패한 곳이 있어도 나머지 결과는 보여줌
  const results = await Promise.allSettled(targets.map((t) => fetchSearch(t.source, q, t.page)));
  results.forEach((res, i) => {
    const { source, page } = targets[i];
    if (res.status === 'fulfilled') {
      addToGroups(source, res.value.items);
      searchState.pages[source] = { page, hasMore: res.value.hasMore && res.value.items.length > 0 };
    } else {
      searchState.failed.push(SEARCH_SOURCES[source].platform);
      // 더 보기에서 실패하면 다음에 같은 페이지를 다시 시도
      if (searchState.pages[source]) searchState.pages[source].hasMore = true;
    }
  });
  searchState.loading = false;
  renderSearchResults();
}

function renderSearchResults() {
  const box = $('s-results');
  const qKey = titleKey(searchState.q);
  // 순서: 제목이 검색어와 똑같은 작품 → 여러 플랫폼에 있는 작품 → 대표 플랫폼 순서 → 처음 나온 순서
  const groups = [...searchState.groups.values()].sort((a, b) =>
    (titleKey(mainItem(b).title) === qKey) - (titleKey(mainItem(a).title) === qKey) ||
    b.items.length - a.items.length ||
    sourceRank(mainItem(a).source) - sourceRank(mainItem(b).source) ||
    a.order - b.order
  );
  const failed = searchState.failed.length
    ? `<p class="msg"><small>검색하지 못한 곳: ${esc(searchState.failed.join(', '))}</small></p>`
    : '';
  if (!groups.length) {
    box.innerHTML = (searchState.failed.length === ALL_SOURCES.length
      ? '<p class="msg">검색에 실패했어요. 잠시 후 다시 해보세요.</p>'
      : '<p class="msg">검색 결과가 없어요.</p>') + failed;
    return;
  }
  const hasMore = Object.values(searchState.pages).some((p) => p.hasMore);
  box.innerHTML = groups.map((g) => {
    const main = mainItem(g);
    const cover = coverItem(g);
    const platforms = [...new Set(g.items.map((i) => SEARCH_SOURCES[i.source].platform))].join(' · ');
    return `
      <button type="button" class="s-item" data-key="${esc(g.key)}">
        <img src="${esc(cover?.cover || '')}" alt="" loading="lazy"${/^#[0-9a-f]{3,8}$/i.test(cover?.coverBg || '') ? ` style="background:${cover.coverBg}"` : ''}>
        <span><b>${esc(main.title)}</b><small>${esc([main.author, TYPES[main.type]].filter(Boolean).join(' · '))}</small><small class="s-platforms">${esc(platforms)}</small></span>
      </button>`;
  }).join('') + failed + (hasMore
    ? `<button type="button" id="s-more" class="ghost s-more">더 보기 (지금 ${groups.length}개)</button>`
    : `<p class="msg">검색 결과 ${groups.length}개를 모두 봤어요.</p>`);
}

// 검색 결과를 누르면 입력칸을 자동으로 채우고, 그 작품이 있는 플랫폼 링크를 모두 넣음
function pickResult(group) {
  const main = mainItem(group);
  const cover = coverItem(group);
  const sorted = [...group.items].sort((a, b) => sourceRank(a.source) - sourceRank(b.source));

  $('f-title').value = main.title;
  $('f-author').value = main.author || '';
  $('f-type').value = main.type;
  $('f-platform').value = [...new Set(sorted.map((i) => SEARCH_SOURCES[i.source].platform))].join(', ');
  $('coverUrl').value = cover?.cover || '';
  setFormCover(cover?.cover || '');
  formLinks = sorted
    .map((i) => ({ name: SEARCH_SOURCES[i.source].platform, url: safeUrl(i.url || linkOf(i.source, i.sourceId)) }))
    .filter((l) => l.url);
  renderLinkList();
  const link = { source: main.source, sourceId: main.sourceId, unit: main.unit || '' };
  formLink = link;
  updateProgressUnit();

  // 표지가 카카오웹툰 것이면 더 좋은 대표 이미지로 바꿈
  const src = cover && SEARCH_SOURCES[cover.source];
  if (src?.fetchCover) {
    src.fetchCover(cover.sourceId).then((url) => {
      if (formLink !== link || !url) return; // 그사이 다른 작품을 골랐으면 무시
      $('coverUrl').value = url;
      setFormCover(url);
    }).catch(() => {});
  }
  $('searchBox').open = false;
  $('s-results').innerHTML = '';
}

// "어디까지 봤나요?" 칸 옆의 단위(화/권) 표시
function updateProgressUnit() {
  $('progressUnit').textContent = unitOf($('f-type').value, formLink?.unit);
}


// ----- 6-3. 보러 갈 곳 (플랫폼 링크) -----

// 직접 넣은 주소의 플랫폼 이름 알아내기
const LINK_NAMES = [
  { match: /comic\.naver\.com/, name: '네이버웹툰' },
  { match: /series\.naver\.com/, name: '네이버 시리즈' },
  { match: /webtoon\.kakao\.com/, name: '카카오웹툰' },
  { match: /page\.kakao\.com/, name: '카카오페이지' },
  { match: /ridibooks\.com/, name: '리디' },
  { match: /mrblue\.com/, name: '미스터블루' },
  { match: /lezhin\.com/, name: '레진코믹스' },
  { match: /munpia\.com/, name: '문피아' },
  { match: /novelpia\.com/, name: '노벨피아' },
];

function nameFromUrl(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return '바로가기'; }
  return LINK_NAMES.find((l) => l.match.test(host))?.name || host.replace(/^www\./, '');
}

// 작품의 보러 갈 곳 목록
// (예전에 저장한 작품은 주소 하나 또는 작품 번호로 만든 주소를 목록으로 바꿔서 보여줌)
function workLinks(w) {
  if (Array.isArray(w.links)) return w.links.filter((l) => safeUrl(l.url));
  const url = 'url' in w ? safeUrl(w.url) : linkOf(w.source, w.sourceId);
  return url ? [{ name: w.platform || nameFromUrl(url), url }] : [];
}

// 입력 창의 보러 갈 곳 목록 그리기
function renderLinkList() {
  $('linkList').innerHTML = formLinks.length
    ? formLinks.map((l, i) => `
        <li>
          <a class="go-link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)} ↗</a>
          <button type="button" class="link" data-i="${i}">삭제</button>
        </li>`).join('')
    : '<li class="muted">아직 없어요</li>';
}

// 주소 직접 추가
function addManualLink() {
  const url = safeUrl($('f-url').value.trim());
  if (!url || nameFromUrl(url) === '바로가기') {
    alert('https:// 로 시작하는 주소를 넣어 주세요.');
    return;
  }
  if (!formLinks.some((l) => l.url === url)) formLinks.push({ name: nameFromUrl(url), url });
  $('f-url').value = '';
  renderLinkList();
}


// ----- 7. 백업 / 복원 -----
function exportBackup() {
  const data = { app: 'my-library', version: 1, exportedAt: new Date().toISOString(), works };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `툰앤소-백업-${new Date().toLocaleDateString('sv-SE')}.json`;
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


// ----- 8. 버튼·입력에 동작 연결 -----
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
    if (e.target.closest('.go-link')) return; // "보러 가기"는 링크만 열고 수정 창은 안 엶
    const plus = e.target.closest('.plus-btn');
    if (plus) { addProgress(plus.dataset.id); return; }
    const card = e.target.closest('.card');
    if (card) openEditor(works.find((w) => w.id === card.dataset.id));
  };
  $('grid').addEventListener('click', onCardClick);
  $('calDayList').addEventListener('click', onCardClick);
  $('readingRow').addEventListener('click', onCardClick);
  $('recentList').addEventListener('click', onCardClick);
  $('feedList').addEventListener('click', onCardClick);

  // 추천: 작가 카드는 그 작가 이름으로 플랫폼 검색, 나머지는 수정 창
  $('recRow').addEventListener('click', (e) => {
    const rec = e.target.closest('[data-author]');
    if (!rec) { onCardClick(e); return; }
    openEditor(null);
    $('s-query').value = rec.dataset.author;
    searchPlatform();
  });

  // 홈 검색창: 작품 추가 창을 열고 플랫폼 검색부터
  $('homeSearch').addEventListener('click', () => openEditor(null));

  // 홈 "전체 보기" / "서재로": 서재 화면으로 이동 (보는 중이면 상태 필터도 같이)
  document.querySelectorAll('.sec-head .more').forEach((btn) => btn.addEventListener('click', () => {
    view.status = btn.dataset.go === 'reading' ? 'reading' : 'all';
    $('statusFilter').value = view.status;
    render();
    setViewMode('library');
  }));

  // 쌓아보기 / 리스트 전환
  $('layoutToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    view.layout = btn.dataset.layout;
    try { localStorage.setItem('layout', view.layout); } catch { /* 저장 못 해도 지금 화면은 바뀜 */ }
    render();
  });

  // 메뉴 바깥을 누르면 메뉴 닫기
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu')) $('menu').open = false;
  });

  // 홈 / 서재 / 캘린더 전환
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
  $('f-type').addEventListener('change', updateProgressUnit);
  // 보러 갈 곳: 주소 직접 추가 (엔터를 눌러도 저장되지 않고 추가되도록) / 삭제
  $('f-url-add').addEventListener('click', addManualLink);
  $('f-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addManualLink(); }
  });
  $('linkList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    formLinks.splice(Number(btn.dataset.i), 1);
    renderLinkList();
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
    if (item) pickResult(searchState.groups.get(item.dataset.key));
  });

  // 백업 / 복원
  $('exportBtn').addEventListener('click', () => { $('menu').open = false; exportBackup(); });
  $('importBtn').addEventListener('click', () => { $('menu').open = false; $('importFile').click(); });
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });
}


// ----- 9. 앱 시작 -----
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
