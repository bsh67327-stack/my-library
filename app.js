// =====================================================
// 툰앤소 - 웹툰/웹소설/만화 기록 앱
// =====================================================

// ----- 1. 기본 설정 -----
const TYPES = { webtoon: '웹툰', webnovel: '웹소설', comic: '만화' };

// 예전 버전의 '일본만화'(manga)는 '만화'로 합침
const fixType = (w) => (w && w.type === 'manga' ? { ...w, type: 'comic' } : w);

// 예전에 웹툰으로 담은 일본 만화(작가 이름으로 판단)를 만화로 바꿈 - 한 번만 실행
// (그 뒤에 직접 웹툰으로 되돌린 작품은 다시 바꾸지 않음)
async function fixSavedManga() {
  try { if (localStorage.getItem('mangaFix1')) return; } catch { return; }
  const isManga = (w) => w.type === 'webtoon' && looksJapaneseAuthor(String(w.author || '').split(/[,/]/));
  const changed = works.filter(isManga).map((w) => ({ ...w, type: 'comic', unit: w.unit || '화' }));
  for (const w of changed) await saveOne(w);
  if (changed.length) works = works.map((w) => changed.find((c) => c.id === w.id) || w);
  try { localStorage.setItem('mangaFix1', '1'); } catch { /* 다음에 다시 시도 */ }
}
const STATUSES = { reading: '보는 중', done: '완독', paused: '보류', dropped: '하차' };

// 앱 버전 (홈 화면 제목 옆에 작게 표시 - index.html의 ?v= 숫자와 맞춰 주세요)
const APP_VERSION = 47;

// 작품 검색 중계 서버 주소 (Cloudflare Worker를 만든 뒤 여기에 붙여넣기)
const SEARCH_SERVER = 'https://my-library-search.bsh67327.workers.dev/';

// 화면 상태: 홈/서재/피드/캘린더 중 어떤 화면인지, 어떤 필터/정렬을 보고 있는지
// layout: 서재를 카드형(card) / 리스트(list) 중 무엇으로 볼지 (마지막에 고른 것을 기억)
// (책을 쌓은 모양은 홈 "최근 기록"으로 옮김)
const LAYOUTS = ['card', 'list'];
const view = { mode: 'home', layout: savedLayout(), type: 'all', status: 'all', sort: 'updated', query: '' };

function savedLayout() {
  try {
    const saved = localStorage.getItem('layout');
    return LAYOUTS.includes(saved) ? saved : 'card';
  } catch {
    return 'card';
  }
}

// 캘린더 상태: 보고 있는 연도/달(0=1월), 선택한 날짜('YYYY-MM-DD')
const now = new Date();
const cal = { year: now.getFullYear(), month: now.getMonth(), selected: null };

let works = [];         // 저장된 모든 작품
let editingId = null;   // 수정 중인 작품 id (새로 추가할 땐 null)
let formCover = '';     // 입력창에서 고른 표지 (이미지 데이터 또는 주소)
let formRating = 0;     // 입력창에서 고른 평점 (0 = 평점 없음)
let formCoverSource = null; // 검색으로 고른 표지와 그 플랫폼 { url, name }

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

// 회차 단위: 플랫폼이 알려준 단위(unit)가 있으면 그걸 쓰고, 없으면 만화는 '권', 나머지는 '화'
function unitOf(type, unit) {
  return unit || (type === 'comic' ? '권' : '화');
}

// 작가 이름이 모두 일본 작가처럼 보이면 일본 만화로 추정 (→ 만화)
// - "Koyoharu Gotouge", "EIICHIRO ODA"처럼 두 단어 이상의 영문
//   ("SIU", "ARCHE"처럼 한 단어 영문 필명과 "Lenvision Animation", "COL GROUP" 같은 회사 이름은 제외)
// - "아쿠타미 게게", "에토 슌지"처럼 띄어 쓴 한글 이름 중 받침이 없거나 ㄴ 받침만 있는 것
//   (일본 이름을 한글로 쓰면 받침이 거의 없음 - "그림왕 양치기", "엘렌 심", "네이버웹툰 작가"는 걸러짐)
// 플랫폼이 일본 만화를 따로 표시하지 않고 웹툰으로 보내는 경우가 많아서 (카카오페이지 연재본, 네이버웹툰 아인 등)
const noBatchimExceptN = (text) => [...text].every((ch) => [0, 4].includes((ch.charCodeAt(0) - 0xac00) % 28));
function looksJapaneseAuthor(names) {
  const list = names.map((n) => String(n).replace(/\([^)]*\)/g, '').trim()).filter(Boolean);
  return list.length > 0 && list.every((n) =>
    !/studio|animation|comics?|cartoon|toon|entertainment|media|works|team|group|production|company/i.test(n) &&
    (/^[A-Za-z.'\-]+( [A-Za-z.'\-]+)+$/.test(n) ||
      (/^[가-힣]{2,5} [가-힣]{1,5}$/.test(n) && noBatchimExceptN(n.replace(' ', '')))));
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

  // (3) 카드형 / 리스트로 그리기
  $('libCount').textContent = list.length || '';
  $('grid').className = `layout-${view.layout}`;
  $('grid').innerHTML = list.map(view.layout === 'card' ? cardHTML : rowHTML).join('');
  document.querySelectorAll('#layoutToggle button')
    .forEach((b) => b.classList.toggle('active', b.dataset.layout === view.layout));

  // (4) 비어 있을 때 안내 문구
  const empty = $('empty');
  empty.hidden = list.length > 0;
  empty.innerHTML = works.length === 0
    ? '아직 기록한 작품이 없어요.<br>오른쪽 아래 <b>＋</b> 버튼으로 첫 작품을 추가해 보세요!'
    : '조건에 맞는 작품이 없어요.';

  $('appVersion').textContent = `v${APP_VERSION}`;
  renderHome();
  renderFeed();
  if (!$('detailPage').hidden) renderDetail();
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

// 카드형: 한 줄에 표지 3개, 표지 왼쪽 위에 종류·플랫폼, 아래에 별점·제목·작가·상태·진행
function cardHTML(w) {
  return `
    <article class="card tile" data-id="${esc(w.id)}">
      <div class="cover">
        <span class="cover-fallback">${esc(w.title)}</span>
        ${w.cover ? `<img src="${esc(w.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        ${badgesHTML(w)}
      </div>
      <div class="tile-info">
        <span class="stars small">${starsHTML(w.rating)}</span>
        <h3>${esc(w.title)}</h3>
        ${w.author ? `<p class="author">${esc(uniqueAuthors(w.author))}</p>` : ''}
        <span class="status status-${w.status}">${STATUSES[w.status]}</span>
        ${progressHTML(w)}
      </div>
    </article>`;
}

// 표지 왼쪽 위 배지: 종류(웹툰·웹소설 등) + 플랫폼 (카드형, 홈 "보는 중"에서 같이 씀)
function badgesHTML(w) {
  return `
    <div class="badges">
      <span class="badge">${TYPES[w.type]}</span>
      ${platformBadge(w.platform)}
    </div>`;
}

// 플랫폼 배지 (플랫폼 이름에 들어간 글자로 판단)
const PLATFORM_BADGES = [
  { match: /네이버|naver/i, label: '네이버', cls: 'naver' },
  { match: /카카오|kakao/i, label: '카카오', cls: 'kakao' },
  { match: /리디|ridi/i, label: '리디', cls: 'ridi' },
  { match: /레진|lezhin/i, label: '레진', cls: 'lezhin' },
  { match: /미스터블루|mrblue/i, label: '미블', cls: 'mrblue' },
];

// 플랫폼이 여러 곳이면 2곳까지 (같은 회사는 하나로: 네이버웹툰 + 네이버 시리즈 → 네이버)
function platformBadge(platform) {
  const brands = [];
  for (const name of String(platform || '').split(',')) {
    const found = PLATFORM_BADGES.find((p) => p.match.test(name));
    if (found && !brands.includes(found)) brands.push(found);
  }
  return brands.slice(0, 2).map((b) => `<span class="badge pf-${b.cls}">${b.label}</span>`).join('');
}

// 리스트 한 줄 (서재 리스트, 홈 최근 기록, 캘린더에서 같이 씀)
function rowHTML(w) {
  return `
    <article class="card item" data-id="${esc(w.id)}">
      ${coverHTML(w, 'thumb')}
      <div class="item-body">
        <p class="kicker">${esc([TYPES[w.type], w.platform].filter(Boolean).join(' · '))}</p>
        <h3>${esc(w.title)}</h3>
        ${w.author ? `<p class="author">${esc(uniqueAuthors(w.author))}</p>` : ''}
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

// 홈 "최근 기록": 작품을 책등처럼 쌓음
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
  const width = 86 + (h % 13);              // 86~98% (제목 10자는 잘리지 않게)
  const shift = ((h >> 5) % 11) - 5;        // 왼쪽/오른쪽으로 -5~5px
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

// 리스트의 플랫폼 바로가기 아이콘 (누르면 원래 플랫폼으로 이동)
function linksHTML(w) {
  const links = workLinks(w);
  if (!links.length) return '';
  return `<div class="go-links">${links.map((l) =>
    `<a class="go-link" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.name)}에서 보기">${pfIconHTML(l.name)}</a>`).join('')}</div>`;
}

// 플랫폼 아이콘: 플랫폼 색 + 첫 글자 (공식 로고 파일이 아니라 직접 그린 표시)
const PLATFORM_ICONS = [
  { match: /베스트도전|도전만화/, cls: 'naver-ch', letter: 'N' },
  { match: /네이버\s*시리즈|시리즈/, cls: 'series', letter: 'S' },
  { match: /네이버/, cls: 'naver', letter: 'N' },
  { match: /카카오웹툰/, cls: 'kakaowebtoon', letter: 'K' },
  { match: /카카오/, cls: 'kakaopage', letter: 'P' },
  { match: /미스터블루/, cls: 'mrblue', letter: 'M' },
  { match: /리디/, cls: 'ridi', letter: 'R' },
  { match: /레진/, cls: 'lezhin', letter: 'L' },
  { match: /문피아/, cls: 'munpia', letter: 'M' },
  { match: /노벨피아/, cls: 'novelpia', letter: 'N' },
];

function pfIconHTML(name) {
  const icon = PLATFORM_ICONS.find((p) => p.match.test(name || ''));
  return `<span class="pf-icon pf-${icon?.cls || 'etc'}" aria-label="${esc(name)}">${esc(icon?.letter || String(name || '?').charAt(0))}</span>`;
}

// 진행 막대 + "32 / 189화" + +1 버튼 (최신 회차는 직접 입력한 값)
function progressHTML(w) {
  if (!w.progress && !w.latest && w.status !== 'reading') return '';
  const unit = unitOf(w.type, w.unit);
  const seen = w.progress || 0;
  return `
    <div class="progress">
      ${w.latest ? `<span class="bar"><i style="width:${Math.min(100, (seen / w.latest) * 100)}%"></i></span>` : ''}
      <span class="progress-text">${seen}${w.latest ? ` / ${w.latest}` : ''}${unit}</span>
      ${w.status === 'reading' ? `<button type="button" class="plus-btn" data-id="${esc(w.id)}">+1</button>` : ''}
    </div>`;
}

// 홈 "내 서재": 기록한 작품을 책등처럼 쌓아서 (맨 위가 가장 최근, 너무 길어지지 않게 30권까지)
const SHELF_MAX = 30;
function renderHome() {
  const byUpdated = [...works].sort((a, b) => b.updatedAt - a.updatedAt);
  $('shelfCount').textContent = works.length || '';
  $('recentList').innerHTML = works.length
    ? `<div class="stack">${byUpdated.slice(0, SHELF_MAX).map(spineHTML).join('')}</div>`
    : '<p class="hint">아직 기록한 작품이 없어요.<br>위 검색창에서 첫 작품을 추가해 보세요!</p>';
}

// 닉네임 (이 폰에 저장하고, 백업 파일에도 같이 넣음). 정하지 않았으면 "독자"
function getNickname() {
  try { return localStorage.getItem('nickname') || ''; } catch { return ''; }
}

function setNickname(name) {
  try { localStorage.setItem('nickname', name); } catch { /* 저장 못 해도 지금 화면에는 반영 */ }
  nicknameNow = name;
}

let nicknameNow = getNickname();
const displayName = () => nicknameNow || '독자';

// 설정 화면 채우기 (닉네임 입력칸, 버전)
function renderSettings() {
  $('nickInput').value = nicknameNow;
  $('settingsVersion').textContent = `v${APP_VERSION}`;
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
        <b>${esc(displayName())}</b>
        <span class="post-time">${timeAgo(w.updatedAt)}</span>
        <span class="status status-${w.status}">${STATUSES[w.status]}</span>
      </div>
      <p class="post-text${w.reviewSpoiler ? ' is-spoiler' : ''}">${esc(w.review)}</p>
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
  $('settingsView').hidden = mode !== 'settings';
  $('addBtn').hidden = mode === 'settings' || mode === 'home'; // 홈(검색창이 있음)·설정에는 ＋ 버튼이 필요 없음
  if (mode === 'settings') renderSettings();
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
  // 저장된 단위가 있으면 그대로, 없으면 종류에 맞춰
  $('f-unit').value = unitOf($('f-type').value, work?.unit || formLink?.unit);
  unitPicked = !!work?.unit;
  $('f-started').value = work?.startedAt || '';
  $('f-finished').value = work?.finishedAt || '';
  $('coverUrl').value = work?.cover && !work.cover.startsWith('data:') ? work.cover : '';
  $('coverFile').value = '';

  setFormCover(work?.cover || '');
  setFormRating(work?.rating || 0);
  formCoverSource = work?.coverSource ? { url: work.cover, name: work.coverSource } : null;

  $('editor').showModal();
  // 창이 열리면 첫 입력칸에 자동으로 커서가 가서 키보드가 바로 올라오므로, 직접 누를 때까지 커서를 빼 둠
  document.activeElement?.blur();
  $('editor').scrollTop = 0;
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
    // 표지를 가져온 플랫폼 (작품 정보 화면에 출처로 표시, 직접 고른 사진이면 비움)
    coverSource: formCoverSource?.url === formCover ? formCoverSource.name : '',
    startedAt: $('f-started').value,
    finishedAt: $('f-finished').value,
    createdAt: old?.createdAt || now,
    updatedAt: now,
    // 플랫폼 연결 정보 (검색으로 추가한 작품만)
    source: formLink?.source || '',
    sourceId: formLink?.sourceId || '',
    unit: $('f-unit').value, // 화(연재본) / 권(단행본)
  };
  if (!work.title) return;

  // '완독'으로 바꾸고 다 본 날이 비어 있으면 오늘 날짜를 넣어줌
  if (work.status === 'done' && !work.finishedAt) {
    work.finishedAt = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD 형식
  }

  await saveOne(work);
  works = old ? works.map((w) => (w.id === work.id ? work : w)) : [...works, work];
  $('editor').close();
  // 검색 결과 정보 화면에서 "내 서재에 담기"로 저장했으면, 그 화면을 내 작품 정보로 바꿈
  if (detailState?.group) detailState = { workId: work.id };
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
  if (detailState?.workId === work.id) closeOverlay();
  render();
}


// ----- 6. 플랫폼에서 작품 검색 -----

// 플랫폼마다 결과 모양이 달라서, 같은 모양으로 바꿔줌
// { sourceId(플랫폼의 작품 번호), title, author, cover, type, url(작품 페이지 주소, 번호로 못 만드는 곳만), note,
//   desc(작품 소개 - 검색 결과에 있는 곳만), genre(장르 - 있는 곳만) }
// 회차 수는 플랫폼에서 가져오지 않고 사용자가 직접 입력함

// 네이버 시리즈: 검색 결과 웹페이지에서 작품 정보를 꺼냄
// kind = 'novel'(웹소설) 또는 'comic'(만화 - 웹툰과 만화책이 섞여 있음)
function parseSeries(html, kind) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('.lst_list li')].map((li) => {
    const link = li.querySelector('h3 a[href*="productNo="]');
    if (!link) return null;
    // 제목 예: "화산귀환[독점] (총 189화/미완결)", 장르 목록에서는 "화산귀환[독점](189화/미완결)"
    // - 회차 수는 버리고 단위(화/권)만 씀
    const text = link.textContent.replace(/\s+/g, ' ').trim();
    const count = text.match(/\((?:총\s*)?[\d,]+\s*(화|권)/);
    const unit = count ? count[1] : '';
    const img = li.querySelector('img');
    // 같은 이름이 두 번 나오는 경우가 많아서(글/그림 작가) 중복 제거
    const authors = [...new Set([...li.querySelectorAll('.author')].map((a) => a.textContent.trim()))];

    // 종류 판단: 웹소설 → 웹소설 / 작가가 영문 이름(일본 만화)·권 단위·[단행본] → 만화 / 나머지 → 웹툰
    let type = 'webtoon';
    if (kind === 'novel') type = 'webnovel';
    else if (looksJapaneseAuthor(authors) || unit === '권' || /\[단행본\]/.test(text)) type = 'comic';

    return {
      sourceId: link.getAttribute('href').match(/productNo=(\d+)/)[1],
      title: text.replace(/\s*\((?:총\s*)?[\d,]+\s*(?:화|권)[^)]*\)\s*$/, '').replace(/\s*\[독점\]/, '').trim(),
      author: authors.join(', '),
      // 19세 작품은 네이버 로그인이 있어야 표지가 보여서 "19" 대체 그림이 옴 → 표지 없음으로 (다른 플랫폼 표지를 씀)
      cover: img && !/19over/.test(img.getAttribute('src')) ? img.getAttribute('src').replace(/\?type=.*$/, '?type=m260') : '',
      type,
      unit,
      note: TYPES[type],
      desc: (li.querySelector('.dsc')?.textContent || '').replace(/​/g, '').trim(),
      ongoing: /미완결/.test(text) ? '연재중' : /완결/.test(text) ? '완결' : '',
      updated: dateNum(li.querySelector('.info')?.textContent), // 예: "... | 2026.09.14. | ..."
    };
  }).filter(Boolean);
}

// 플랫폼이 알려준 최근 업데이트 날짜 → 비교용 숫자 (없으면 0)
// "2026.09.14" / "25.02.02" / "2026-10-09T22:01:05+09:00" 모양을 읽음
function dateNum(text) {
  const s = String(text || '');
  const iso = Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(iso)) return iso;
  const m = s.match(/(\d{4}|\d{2})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return 0;
  const year = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
  return new Date(year, Number(m[2]) - 1, Number(m[3])).getTime();
}

const seriesSource = (kind) => ({
  platform: '네이버 시리즈',
  format: 'html',
  parse: (html) => parseSeries(html, kind),
  hasMore: (html, page, items) => items.length >= 25, // 한 페이지에 25개씩
  // 장르는 검색 결과에 없어서 작품 페이지에서 꺼내 옴 (검색 서버가 장르·연재 상태·소개만 보내 줌)
  fetchInfo: async (item) => {
    const data = await callServer('seriesInfo', `${kind}/${item.sourceId}`);
    return {
      genre: data.genre || '',
      ongoing: /미완결|연재/.test(data.ongoing || '') ? '연재중' : /완결/.test(data.ongoing || '') ? '완결' : '',
      desc: data.desc || '',
      tags: data.tags || [],
    };
  },
});

// 미스터블루: 검색 결과 웹페이지에서 작품 정보를 꺼냄
function parseMrblue(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 진짜 검색 결과는 #listBox 안에만 있음 (결과가 없으면 '추천 신작' 목록이 대신 나와서 그건 빼야 함)
  return [...doc.querySelectorAll('#listBox li[data-pid]')].map((li) => {
    const link = li.querySelector('.tit a');
    if (!link) return null;
    // 인문·자기계발 같은 일반 도서(장르 "일반 > 일반도서")는 이 앱에서 다루지 않아서 뺌
    if (/일반도서/.test(li.querySelector('.genre')?.textContent || '')) return null;
    const category = li.querySelector('.label-category')?.textContent.trim() || ''; // 웹툰 / 만화 / 소설
    // 제목 링크 안에 [만화] 표시가 같이 있어서 글자 부분만 꺼냄
    const title = [...link.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
    const info = (li.querySelector('.info')?.textContent || '').replace(/\s+/g, ' '); // 예: "2026.10.01 730화 연재 대원씨아이"
    const count = info.match(/[\d,]+\s*(화|권)/); // 회차 수는 버리고 단위(화/권)만 씀
    const authors = [...new Set([...li.querySelectorAll('.authorname')].map((a) => a.textContent.trim()))];
    const href = link.getAttribute('href');
    return {
      sourceId: li.dataset.pid,
      title,
      author: authors.join(', '),
      cover: mrblueCover(li, category === '소설' ? 'webnovel' : 'comic'),
      type: category === '소설' ? 'webnovel' : category === '웹툰' ? 'webtoon' : 'comic',
      unit: count ? count[1] : '',
      url: href ? new URL(href, 'https://www.mrblue.com').href : '',
      note: category,
      ongoing: /완결/.test(info) ? '완결' : /연재/.test(info) ? '연재중' : '',
      updated: dateNum(info),
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
    desc: w.synopsis || '',
    ongoing: w.finished ? '완결' : '연재중',
    updated: dateNum(w.lastArticleServiceDate), // 예: "25.02.02"
  })),
  hasMore: (data, page) => page + 1 < (data.pageInfo?.totalPages || 0),
  // 장르와 태그는 검색 결과에 없어서 작품 정보에서 불러옴 (GENRE_로 시작하는 태그가 장르)
  fetchInfo: async (item) => {
    const data = await callServer('naverInfo', String(item.sourceId));
    const tags = data.curationTagList || [];
    return {
      genre: tags.find((t) => /^GENRE_/.test(t.curationType))?.tagName || '',
      tags: tags.filter((t) => !/^GENRE_/.test(t.curationType)).map((t) => t.tagName).filter(Boolean).slice(0, 10),
      ongoing: data.finished ? '완결' : '연재중',
      desc: data.synopsis || '',
    };
  },
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
    // 한 페이지에 120개씩 (일반 도서를 뺀 개수가 아니라 원래 목록 개수로 판단)
    hasMore: (html) => (html.match(/<li[^>]*data-pid=/g) || []).length >= 120,
    // 작품 소개는 검색 결과에 없어서 작품 페이지에서 꺼내 옴 (검색 서버가 소개 글만 보내 줌)
    fetchInfo: async (item) => {
      let path = '';
      try { path = new URL(item.url).pathname.slice(1); } catch { return {}; }
      if (!/^(novel|comic|webtoon)\/[A-Za-z0-9_]+$/.test(path)) return {};
      const data = await callServer('mrblueInfo', path);
      return { desc: data.desc || '', tags: data.tags || [] };
    },
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
      genre: c.genre || '',
      desc: c.catchphraseThreeLines || c.catchphraseTwoLines || '', // 짧은 소개 (전체 소개는 fetchInfo로)
    })),
    hasMore: (data) => data.meta?.pagination ? !data.meta.pagination.last : false,
    // 작품 정보 화면을 열면 대표 이미지·전체 작품 소개·연재 상태와, 프로필의 키워드(태그로 씀)를 불러옴
    fetchInfo: async (item) => {
      const id = String(item.sourceId);
      const [info, profile] = await Promise.all([
        callServer('kakaoWebtoonInfo', id),
        callServer('kakaoWebtoonProfile', id).catch(() => ({})), // 키워드를 못 받아도 나머지는 보여줌
      ]);
      const share = info.data?.sharingThumbnailImage;
      // 연재 상태 배지: COMPLETED 완결 / EPISODES_PUBLISHING 연재중 / END_OF_SEASON 시즌 완결
      const status = (info.data?.badges || []).find((b) => b.type === 'STATUS')?.title;
      const ongoing = { COMPLETED: '완결', EPISODES_PUBLISHING: '연재중', END_OF_SEASON: '시즌 완결' }[status] || '';
      const genre = typeof info.data?.genre === 'string' ? info.data.genre : '';
      // 키워드에 장르(예: #판타지 드라마)가 같이 들어 있어서 장르는 빼고 태그로
      const tags = (profile.keywords || []).filter((k) => k !== genre).slice(0, 10);
      return { cover: share ? `${share}.jpg` : '', desc: info.data?.synopsis || '', ongoing, genre, tags };
    },
  },
  // 리디는 검색 요청을 막고 있어서(403) 검색에서 뺌 - 리디 링크는 직접 추가할 수 있음
  kakao: {
    platform: '카카오페이지',
    // 카카오페이지의 '책'(인문·자기계발 등 일반 도서)은 이 앱에서 다루지 않아서 뺌
    parse: (data) => (data.result?.list || []).filter((s) => s.category !== '책').map((s) => ({
      sourceId: s.series_id,
      title: s.title,
      author: s.authors,
      cover: `https://page-images.kakaoentcdn.com/download/resource?kid=${s.thumbnail}&filename=th3`,
      // 카카오페이지가 일본 만화로 표시한 작품(is_manga)은 만화로
      type: s.operator_property?.is_manga ? 'comic' : s.category === '웹툰' ? 'webtoon' : 'webnovel',
      note: s.category || '',
      genre: s.sub_category || '',
      // on_issue: Y = 연재중, N = 완결 (P 등 다른 값은 뜻이 확실하지 않아서 비워 둠)
      ongoing: s.on_issue === 'Y' ? '연재중' : s.on_issue === 'N' ? '완결' : '',
      updated: dateNum(s.last_slide_added_dt),
    })),
    // 작품 소개와 태그는 검색 결과에 없어서 작품 정보에서 불러옴
    fetchInfo: async (item) => {
      const data = await callServer('kakaoAbout', String(item.sourceId));
      return {
        desc: data.result?.description || '',
        tags: (data.result?.theme_keyword_list || []).map((k) => k.title).filter(Boolean).slice(0, 10),
        genre: data.result?.detail?.category_list?.[1] || '', // 예: ["웹소설", "로판"]
      };
    },
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
  items.forEach((i) => { i.author = uniqueAuthors(i.author); });
  return { items, hasMore: src.hasMore(data, page, items) };
}

// 글/그림 작가가 같은 사람이면 이름이 두 번 오는 곳이 있어서 한 번만 (예: "네스티캣, 네스티캣" → "네스티캣")
function uniqueAuthors(author) {
  return [...new Set(String(author || '').split(/[,/]/).map((a) => a.trim()).filter(Boolean))].join(', ');
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
let searchState = { q: '', groups: new Map(), pages: {}, failed: [], loading: false, filter: { type: 'all', platform: 'all' } };
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

// 묶음의 표지: 가장 최근에 업데이트된 플랫폼의 표지 (날짜가 같거나 없으면 플랫폼 순서대로)
// 검색 목록·작품 정보·서재에 담을 때 모두 이 표지 하나를 씀
// (카카오웹툰 검색 결과는 캐릭터 그림이라, 다른 플랫폼 표지가 있으면 그걸 씀)
function coverItem(group) {
  const withCover = [...group.items].filter((i) => i.cover)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0) || sourceRank(a.source) - sourceRank(b.source));
  return withCover.find((i) => i.source !== 'kakaoWebtoon') || withCover[0] || null;
}

// 새로 검색 (more = true면 다음 페이지가 있는 플랫폼만 이어서 불러옴)
// fromFinder = true면 검색어 대신 작품 찾기에서 고른 장르로 (searchState.finder 를 미리 넣어 둠)
async function searchPlatform(more = false, fromFinder = false) {
  const box = $('s-results');
  if (!SEARCH_SERVER) {
    box.innerHTML = '<p class="msg">검색 서버가 아직 연결되지 않았어요. (app.js의 SEARCH_SERVER)</p>';
    return;
  }
  if (searchState.loading) return;

  let targets;
  if (more) {
    targets = Object.entries(searchState.pages)
      .filter(([, p]) => p.hasMore)
      .map(([source, p]) => ({ source, page: p.page + 1 }));
    const btn = $('s-more');
    if (btn) { btn.disabled = true; btn.textContent = '불러오는 중…'; }
  } else if (fromFinder) {
    targets = searchState.finder.sources.map((source) => ({ source, page: 0 }));
    box.innerHTML = `<p class="msg">${esc(searchState.finder.genre.name)} 작품을 찾는 중…</p>`;
  } else {
    const q = $('s-query').value.trim();
    if (!q) return;
    searchState = { q, groups: new Map(), pages: {}, failed: [], loading: false, filter: { type: 'all', platform: 'all' } };
    targets = ALL_SOURCES.map((source) => ({ source, page: 0 }));
    box.innerHTML = '<p class="msg">모든 플랫폼에서 찾는 중…</p>';
  }

  searchState.loading = true;
  searchState.failed = [];
  const { q, finder } = searchState;
  // 모든 플랫폼에 동시에 요청하고, 실패한 곳이 있어도 나머지 결과는 보여줌
  // (작품 찾기는 플랫폼의 장르 목록 순서(인기순)를 rank 로 기억해 둠)
  const run = async (t) => {
    const res = finder ? await FINDER_FETCH[t.source](finder.genre, t.page, finder.types) : await fetchSearch(t.source, q, t.page);
    res.items.forEach((item, i) => {
      item.rank = t.page * 100 + i;
      // 일본 만화를 화 단위로 나눠 연재하는 작품은 플랫폼이 웹툰으로 보내서, 작가 이름으로 만화로 바꿈 (모든 플랫폼)
      if (item.type === 'webtoon' && looksJapaneseAuthor(String(item.author || '').split(/[,/]/))) {
        item.type = 'comic';
        if (!item.unit) item.unit = '화'; // 화 단위로 연재하는 작품이라 '권'이 아니라 '화'
      }
    });
    return res;
  };
  const results = await Promise.allSettled(targets.map(run));
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
  const { finder } = searchState;
  const qKey = titleKey(searchState.q);
  const bestRank = (g) => Math.min(...g.items.map((i) => i.rank ?? 9999));
  // 순서: 제목이 검색어와 똑같은 작품 → 여러 플랫폼에 있는 작품 → 대표 플랫폼 순서 → 처음 나온 순서
  // (작품 찾기는 플랫폼 목록 순서를 섞어서: 각 플랫폼 1번째끼리 → 2번째끼리 …)
  let all = [...searchState.groups.values()].sort(finder
    ? (a, b) => bestRank(a) - bestRank(b) || sourceRank(mainItem(a).source) - sourceRank(mainItem(b).source)
    : (a, b) =>
      (titleKey(mainItem(b).title) === qKey) - (titleKey(mainItem(a).title) === qKey) ||
      b.items.length - a.items.length ||
      sourceRank(mainItem(a).source) - sourceRank(mainItem(b).source) ||
      a.order - b.order
  );
  // 작품 찾기에서 고른 종류 / 연재 상태로 거름
  if (finder) {
    all = all.filter((g) =>
      (!finder.types.size || finder.types.has(mainItem(g).type)) &&
      (!finder.ongoing || mergeOngoing(g.items.map((i) => i.ongoing)) === finder.ongoing));
  }
  const failed = searchState.failed.length
    ? `<p class="msg"><small>${finder ? '불러오지 못한 곳' : '검색하지 못한 곳'}: ${esc(searchState.failed.join(', '))}</small></p>`
    : '';
  if (!all.length) {
    box.innerHTML = (searchState.failed.length === (finder ? finder.sources.length : ALL_SOURCES.length)
      ? '<p class="msg">검색에 실패했어요. 잠시 후 다시 해보세요.</p>'
      : '<p class="msg">검색 결과가 없어요.</p>') + failed;
    return;
  }

  // 종류 / 플랫폼 필터 (결과에 있는 것만 버튼으로)
  const f = searchState.filter;
  const platformOf = (i) => SEARCH_SOURCES[i.source].platform;
  const typesIn = Object.keys(TYPES).filter((t) => all.some((g) => mainItem(g).type === t));
  const platformsIn = [...new Set(ALL_SOURCES.map((s) => SEARCH_SOURCES[s].platform))]
    .filter((p) => all.some((g) => g.items.some((i) => platformOf(i) === p)));
  const chip = (kind, value, label) =>
    `<button type="button" class="f-chip${f[kind] === value ? ' active' : ''}" data-filter="${kind}" data-value="${esc(value)}">${esc(label)}</button>`;
  const filters = `
    <div class="s-filters">
      <div class="f-row">${chip('type', 'all', '전체')}${typesIn.map((t) => chip('type', t, TYPES[t])).join('')}</div>
      <div class="f-row">${chip('platform', 'all', '모든 플랫폼')}${platformsIn.map((p) => chip('platform', p, p)).join('')}</div>
    </div>`;
  const groups = all.filter((g) =>
    (f.type === 'all' || mainItem(g).type === f.type) &&
    (f.platform === 'all' || g.items.some((i) => platformOf(i) === f.platform)));

  const hasMore = Object.values(searchState.pages).some((p) => p.hasMore);
  const countLabel = finder ? `${finder.genre.name} 작품` : '검색 결과';
  box.innerHTML = filters + `<p class="s-count">${esc(countLabel)} ${groups.length}${hasMore ? '+' : ''}</p>`
    + (groups.length ? '' : '<p class="msg">조건에 맞는 작품이 없어요.</p>') + groups.map((g) => {
    const main = mainItem(g);
    const cover = coverItem(g);
    const platforms = [...new Set(g.items.map((i) => SEARCH_SOURCES[i.source].platform))];
    return `
      <button type="button" class="s-item" data-key="${esc(g.key)}">
        <img src="${esc(cover?.cover || '')}" alt="" loading="lazy"${/^#[0-9a-f]{3,8}$/i.test(cover?.coverBg || '') ? ` style="background:${cover.coverBg}"` : ''}>
        <span class="s-body">
          <b>${esc(main.title)}</b>
          <small>${esc([main.author, TYPES[main.type], g.items.find((i) => i.ongoing)?.ongoing].filter(Boolean).join(' · '))}</small>
          <span class="pf-icons">${platforms.map((p) => pfIconHTML(p)).join('')}</span>
        </span>
        ${findInLibrary(g) ? '<span class="in-library">내 서재</span>' : ''}
      </button>`;
  }).join('') + failed + (hasMore
    ? `<button type="button" id="s-more" class="ghost s-more">더 보기</button>`
    : `<p class="msg">검색 결과를 모두 봤어요.</p>`);
}


// ----- 6-2-1. 작품 찾기 (홈 배너 "뭐 볼지 고민될 때") -----
// 장르를 고르면 플랫폼마다 장르별 목록을 받아서 검색 결과 화면에 보여줌
// (네이버웹툰·카카오웹툰·네이버 시리즈는 인기순/판매순, 카카오페이지는 업데이트순, 미스터블루는 사이트 기본 순서)
// 플랫폼마다 장르를 부르는 방법이 달라서 장르마다 적어 둠
//   naver: 네이버웹툰 장르 코드 / naverTag: 네이버웹툰 태그 번호 (장르에 없는 로판·현판·학원물)
//   kw: 카카오웹툰 장르 이름
//   kpToon·kpNovel: 카카오페이지 웹툰·웹소설 세부 장르 번호
//   novel·comic: 네이버 시리즈 웹소설·만화 장르 코드
//   mbToon·mbComic·mbNovel: 미스터블루 웹툰·만화·소설 장르 페이지 주소
const MB_COMIC = (genre, id) => `comic/list?genre=${genre}&genreIds=${id}`;
const FINDER_GENRES = [
  { name: '로맨스', naver: ['PURE'], kw: '로맨스', kpToon: '121', kpNovel: '89', novel: '201', comic: '99',
    mbToon: 'webtoon/genre/romance', mbComic: MB_COMIC('ROMANCE', '01'), mbNovel: 'novel/genre/romance/' },
  { name: '로판', naverTag: '51', kw: '로맨스 판타지', kpToon: '69', kpNovel: '117', novel: '207',
    mbNovel: 'novel/genre/romance/romancefantasy' },
  { name: '판타지', naver: ['FANTASY'], kw: '판타지 드라마', kpToon: '115', kpNovel: '86', novel: '202',
    mbToon: 'webtoon/genre/fantasy', mbComic: MB_COMIC('ACTION-FANTASY', '05'), mbNovel: 'novel/genre/fantasy/' },
  { name: '현판', naverTag: '379', kpNovel: '120', novel: '208', mbNovel: 'novel/genre/fantasy/modernfantasy' },
  { name: '무협', naver: ['HISTORICAL'], kw: '액션/무협', kpToon: '112', kpNovel: '87', novel: '206', comic: '88',
    mbComic: MB_COMIC('HEROISM', '04'), mbNovel: 'novel/genre/heroism/' },
  { name: '액션', naver: ['ACTION'], kw: '액션/무협', kpToon: '122', comic: '90',
    mbToon: 'webtoon/genre/action', mbComic: MB_COMIC('ACTION-FANTASY', '24') },
  { name: '드라마', naver: ['DRAMA'], kw: '드라마', kpToon: '116', comic: '93',
    mbToon: 'webtoon/genre/drama', mbComic: MB_COMIC('ACTION-FANTASY', '07') },
  { name: '스릴러', naver: ['THRILL'], kw: '공포/스릴러', novel: '203',
    mbToon: 'webtoon/genre/thriller', mbNovel: 'novel/genre/others/mysterythriller' },
  { name: '일상·개그', naver: ['DAILY', 'COMIC'], kw: '코믹/일상' },
  { name: '감성', naver: ['SENSIBILITY'] },
  { name: '학원', naverTag: '95', kw: '학원/판타지', mbComic: MB_COMIC('ACTION-FANTASY', '02') },
  { name: '스포츠', naver: ['SPORTS'], mbComic: MB_COMIC('ACTION-FANTASY', '09') },
  { name: '라노벨', novel: '205', mbNovel: 'novel/genre/fantasy/lightnovel' },
  { name: 'BL', kpToon: '119', kpNovel: '123', novel: '209', comic: '107',
    mbToon: 'webtoon/genre/bl', mbComic: MB_COMIC('BL', '22'), mbNovel: 'novel/genre/bl/' },
];
const FINDER_PLATFORMS = ['네이버웹툰', '카카오웹툰', '카카오페이지', '네이버 시리즈', '미스터블루'];

// 고른 종류에 맞는 목록만 (types 가 비어 있으면 전체)
const wantType = (types, ...these) => !types.size || these.some((t) => types.has(t));

// 플랫폼별 장르 목록 받기 → { items, hasMore } (검색 결과와 같은 모양)
// 한 플랫폼에서 여러 목록(예: 웹툰 + 웹소설)을 받으면 합쳐서 돌려줌
async function mergeLists(jobs) {
  const lists = await Promise.all(jobs);
  return { items: lists.flatMap((l) => l.items), hasMore: lists.some((l) => l.hasMore) };
}

// 네이버웹툰 장르·태그 목록 한 줄 → 검색 결과 모양
const naverListItem = (w) => ({
  sourceId: w.titleId,
  title: w.titleName,
  author: uniqueAuthors(w.author || w.displayAuthor),
  cover: w.thumbnailUrl,
  type: 'webtoon',
  note: '',
  ongoing: (w.finish ?? w.finished) ? '완결' : '연재중',
});
const naverHasMore = (d) => (d.pageInfo?.page || 0) < (d.pageInfo?.totalPages || 0);

const FINDER_FETCH = {
  naverWebtoon: (g, page) => mergeLists([
    ...(g.naver || []).map(async (code) => {
      const d = await callServer('naverGenre', code, page);
      return { items: (d.titleList || []).map(naverListItem), hasMore: naverHasMore(d) };
    }),
    ...(g.naverTag ? [(async () => {
      const d = await callServer('naverTag', g.naverTag, page);
      return { items: (d.curationViewList || []).map(naverListItem), hasMore: naverHasMore(d) };
    })()] : []),
  ]),
  // 카카오웹툰은 장르 이름으로 검색하면 장르 작품이 나옴 (제목에 그 낱말만 들어간 작품은 뺌)
  kakaoWebtoon: async (g, page) => {
    const res = await fetchSearch('kakaoWebtoon', g.kw, page);
    return { items: res.items.filter((i) => i.genre === g.kw), hasMore: res.hasMore };
  },
  // 카카오페이지 장르 목록은 검색 결과와 모양이 같아서 검색 결과 읽는 법을 그대로 씀
  kakao: (g, page, types) => mergeLists([
    g.kpToon && wantType(types, 'webtoon', 'comic') && `10/${g.kpToon}`,
    g.kpNovel && wantType(types, 'webnovel') && `11/${g.kpNovel}`,
  ].filter(Boolean).map(async (q) => {
    const d = await callServer('kakaoGenre', q, page);
    const items = SEARCH_SOURCES.kakao.parse(d);
    items.forEach((i) => { i.author = uniqueAuthors(i.author); });
    return { items, hasMore: SEARCH_SOURCES.kakao.hasMore(d) };
  })),
  seriesNovel: (g, page) => seriesGenreList('novel', g.novel, page),
  seriesComic: (g, page) => seriesGenreList('comic', g.comic, page),
  // 미스터블루 장르 페이지는 한 번에 100~120개 (다음 페이지는 없음)
  mrblue: (g, page, types) => mergeLists([
    g.mbToon && wantType(types, 'webtoon') && [g.mbToon, 'webtoon'],
    g.mbComic && wantType(types, 'comic') && [g.mbComic, 'comic'],
    g.mbNovel && wantType(types, 'webnovel') && [g.mbNovel, 'webnovel'],
  ].filter(Boolean).map(async ([path, type]) =>
    ({ items: parseMrblueGenre(await callServer('mrblueGenre', path, page, true), type), hasMore: false }))),
};

async function seriesGenreList(kind, code, page) {
  const items = parseSeries(await callServer('seriesGenre', `${kind}/${code}`, page, true), kind);
  items.forEach((i) => { i.author = uniqueAuthors(i.author); });
  return { items, hasMore: items.length >= 25 }; // 한 페이지에 25개씩
}

// 미스터블루 표지: 페이지에 있으면 그걸 쓰고 (웹툰의 가로 그림 wide.jpg 는 세로 표지로 바꿈),
// 19세 작품처럼 페이지에 표지가 없으면 작품 번호로 표지 주소를 만듦 (소설은 ebook, 나머지는 comics 폴더)
// TODO: 나중에 성인 인증을 넣으면 19세 작품 표지는 인증한 사람에게만 보여주기
function mrblueCover(li, type) {
  const img = li.querySelector('img');
  const src = img ? (img.getAttribute('data-original') || img.getAttribute('src') || '') : '';
  if (src) return src.replace(/\/wide\.jpg$/, '/cover_w480.jpg');
  const pid = li.dataset.pid;
  return /^[A-Za-z0-9_]+$/.test(pid || '')
    ? `https://img.mrblue.com/prod_img/${type === 'webnovel' ? 'ebook' : 'comics'}/${pid}/cover_w480.jpg` : '';
}

// 미스터블루 장르 페이지에서 작품 정보를 꺼냄 (검색 결과와 모양이 달라서 따로)
function parseMrblueGenre(html, type) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('#listBox li[data-pid]')].map((li) => {
    const link = li.querySelector('.tit a');
    if (!link) return null;
    const href = link.getAttribute('href');
    // 작가 이름 앞의 "(원작)" 같은 표시는 뺌
    const authors = [...li.querySelectorAll('.name a[href*="/author"]')]
      .map((a) => (a.getAttribute('title') || a.textContent).replace(/^\([^)]*\)/, '').trim());
    return {
      sourceId: li.dataset.pid,
      title: (link.getAttribute('title') || link.textContent).replace(/\s+/g, ' ').trim(),
      author: uniqueAuthors(authors.join(', ')),
      cover: mrblueCover(li, type),
      type,
      url: href ? new URL(href, 'https://www.mrblue.com').href : '',
      note: TYPES[type],
      ongoing: '', // 장르 페이지에는 연재 상태가 없음
    };
  }).filter(Boolean);
}

// 작품 찾기 화면에서 고른 것 (types·platforms 가 비어 있으면 전체)
let finderPick = { genre: '', types: new Set(), platforms: new Set(), ongoing: '' };

function openFinder() {
  renderFinder();
  openOverlay('finderPage');
  $('finderPage').scrollTop = 0;
}

function renderFinder() {
  const pick = (kind, value, label, on) =>
    `<button type="button" class="f-pick${on ? ' active' : ''}" data-pick="${kind}" data-value="${esc(value)}">${esc(label)}</button>`;
  $('finderGenres').innerHTML = FINDER_GENRES.map((g) => pick('genre', g.name, g.name, finderPick.genre === g.name)).join('');
  $('finderTypes').innerHTML = Object.entries(TYPES).map(([t, label]) => pick('types', t, label, finderPick.types.has(t))).join('');
  $('finderPlatforms').innerHTML = FINDER_PLATFORMS.map((p) => pick('platforms', p, p, finderPick.platforms.has(p))).join('');
  $('finderOngoing').innerHTML = ['연재중', '완결'].map((o) => pick('ongoing', o, o, finderPick.ongoing === o)).join('');
}

// 고른 장르·종류·플랫폼·연재 상태로 받아 올 곳
// (카카오웹툰·미스터블루는 목록에 연재 상태가 없어서 연재 상태를 고르면 뺌)
function finderSources(g) {
  const ok = (platform, ...types) =>
    (!finderPick.platforms.size || finderPick.platforms.has(platform)) && wantType(finderPick.types, ...types);
  return [
    (g.naver || g.naverTag) && ok('네이버웹툰', 'webtoon') && 'naverWebtoon',
    g.kw && !finderPick.ongoing && ok('카카오웹툰', 'webtoon') && 'kakaoWebtoon',
    ((g.kpToon && ok('카카오페이지', 'webtoon', 'comic')) || (g.kpNovel && ok('카카오페이지', 'webnovel'))) && 'kakao',
    g.novel && ok('네이버 시리즈', 'webnovel') && 'seriesNovel',
    g.comic && ok('네이버 시리즈', 'webtoon', 'comic') && 'seriesComic',
    !finderPick.ongoing && ((g.mbToon && ok('미스터블루', 'webtoon')) || (g.mbComic && ok('미스터블루', 'comic'))
      || (g.mbNovel && ok('미스터블루', 'webnovel'))) && 'mrblue',
  ].filter(Boolean);
}

function runFinder() {
  const g = FINDER_GENRES.find((x) => x.name === finderPick.genre);
  if (!g) { toast('장르를 골라 주세요'); return; }
  const sources = finderSources(g);
  if (!sources.length) { toast('이 조건으로 찾을 수 있는 곳이 없어요'); return; }
  searchState = {
    q: '', groups: new Map(), pages: {}, failed: [], loading: false, filter: { type: 'all', platform: 'all' },
    finder: { genre: g, sources, types: new Set(finderPick.types), ongoing: finderPick.ongoing },
  };
  openOverlay('searchPage');
  $('s-query').value = '';
  $('searchIntro').hidden = true;
  $('s-results').hidden = false;
  $('searchPage').scrollTop = 0;
  searchPlatform(false, true);
}


// "어디까지 봤나요?" 칸 옆의 단위(화/권) 표시
// 직접 고르기 전에는 종류에 맞춰 바뀜 (만화는 권, 나머지는 화)
let unitPicked = false;
function updateProgressUnit() {
  if (!unitPicked) $('f-unit').value = unitOf($('f-type').value, formLink?.unit);
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


// ----- 6-4. 검색 화면 (홈 검색창이나 ＋ 버튼을 누르면 열림) -----
// 처음에는 최근 검색어·좋아한 작가·추천 키워드, 검색하면 결과 목록
const RECENT_KEY = 'recentSearches';
const SUGGEST_KEYWORDS = ['회귀', '빙의', '환생', '헌터', '무협', '로맨스판타지', '아카데미', '먼치킨', '아포칼립스', '게임'];

function recentSearches() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}

function saveRecentSearches(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10))); } catch { /* 저장 못 해도 검색은 됨 */ }
}

function openSearch(q = '') {
  openOverlay('searchPage');
  if (q) {
    runSearch(q);
  } else {
    $('s-query').value = '';
    showSearchIntro();
    $('s-query').focus({ preventScroll: true });
  }
}

function showSearchIntro() {
  $('searchIntro').hidden = false;
  $('s-results').hidden = true;

  const recent = recentSearches();
  $('recentBlock').hidden = !recent.length;
  $('recentKeywords').innerHTML = recent.map((k) => `
    <span class="chip chip-recent">
      <button type="button" class="chip-word" data-q="${esc(k)}">${esc(k)}</button>
      <button type="button" class="chip-x" data-remove="${esc(k)}" aria-label="${esc(k)} 지우기">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </span>`).join('');

  // 장르별 검색: 장르 아이콘 (작품 찾기의 장르와 같음)
  $('genreIcons').innerHTML = FINDER_GENRES.map((g) => {
    const icon = GENRE_ICONS[g.name] || GENRE_ICONS.판타지;
    return `
      <button type="button" class="genre-icon" data-genre="${esc(g.name)}" style="--g:${icon.color}">
        <span class="gi-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.path}</svg></span>
        <span class="gi-name">${esc(g.name)}</span>
      </button>`;
  }).join('');

  // 4점 이상 준 작품의 작가 (최대 6명)
  const authors = [...new Set(works.filter((w) => w.rating >= 4 && w.author)
    .sort((a, b) => b.rating - a.rating)
    .map((w) => w.author.split(/[,/·]/)[0].trim())
    .filter(Boolean))].slice(0, 6);
  $('authorBlock').hidden = !authors.length;
  $('authorKeywords').innerHTML = authors.map((a) =>
    `<button type="button" class="chip chip-word" data-q="${esc(a)}">${esc(a)}</button>`).join('');

  $('suggestKeywords').innerHTML = SUGGEST_KEYWORDS.map((k) =>
    `<button type="button" class="chip chip-word" data-q="${esc(k)}">${esc(k)}</button>`).join('');
}

// 장르별 검색 아이콘: 장르마다 색 + 직접 그린 선 그림 (24x24)
const GENRE_ICONS = {
  로맨스: { color: '#e8456b', path: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>' },
  로판: { color: '#9b51e0', path: '<path d="M4 8l4 4 4-7 4 7 4-4-2 11H6z"/>' },
  판타지: { color: '#4a6cf7', path: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/><path d="M19 3v3M17.5 4.5h3"/>' },
  현판: { color: '#1b8ad6', path: '<path d="M3 21h18M5 21V10h5v11M10 21V4h9v17M13 8h3M13 12h3M13 16h3"/>' },
  무협: { color: '#9a6a3a', path: '<path d="M20 4 9 15M14 4h6v6M7 13l4 4M4 20l3-3"/>' },
  액션: { color: '#f06b1a', path: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' },
  드라마: { color: '#2f9e5c', path: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>' },
  스릴러: { color: '#4b4f63', path: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>' },
  '일상·개그': { color: '#d99a00', path: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h0M15 9.5h0"/>' },
  감성: { color: '#2a9d8f', path: '<path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/>' },
  학원: { color: '#3b66d1', path: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/>' },
  스포츠: { color: '#2e9d47', path: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>' },
  라노벨: { color: '#d0489a', path: '<path d="M4 19V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0 0 4h14"/>' },
  BL: { color: '#3a86ff', path: '<path d="M8 18s-5-3-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2"/><path d="M16 21s-5-3-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 4-5 7-5 7z"/>' },
};

function runSearch(q) {
  q = q.trim();
  if (!q) return;
  $('s-query').value = q;
  $('s-query').blur(); // 휴대폰 키보드 내리기
  saveRecentSearches([q, ...recentSearches().filter((k) => k !== q)]);
  $('searchIntro').hidden = true;
  $('s-results').hidden = false;
  searchPlatform();
}


// ----- 6-5. 작품 정보 화면 (웹소소처럼: 작품 정보 + 내 기록을 이 화면에서 바로) -----
// detailState: { workId } 내 서재 작품 / { group, info } 아직 서재에 없는 검색 결과
//   (info: 정보 화면을 열 때 더 불러온 { cover, desc } - 카카오웹툰만)
let detailState = null;

// 검색 결과가 이미 내 서재에 있는지 (제목·종류가 같으면 같은 작품)
function findInLibrary(group) {
  const main = mainItem(group);
  return works.find((w) => titleKey(w.title) === titleKey(main.title) && w.type === main.type);
}

// 연재 상태 합치기: 플랫폼마다 반영이 늦을 수 있어서 한 곳이라도 완결이면 완결
function mergeOngoing(values) {
  const list = values.filter(Boolean);
  return ['완결', '시즌 완결', '연재중'].find((v) => list.includes(v)) || '';
}

// 검색 결과 묶음을 작품 모양으로 (플랫폼 순서상 앞에 있는 것부터 씀)
// info: 정보 화면을 열 때 더 불러온 { cover, desc, genre, tags, ongoing }
function groupAsWork(group, info = {}) {
  const main = mainItem(group);
  const cover = coverItem(group);
  const sorted = [...group.items].sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
  // 작품 소개는 가장 긴 것 (카카오웹툰은 검색 결과에 짧은 소개만 있어서)
  const descs = [info.desc, ...sorted.map((i) => i.desc)].filter(Boolean);
  // 표지는 검색 목록과 같은 것 (카카오웹툰 표지밖에 없을 때만 캐릭터 그림 대신 대표 이미지로 바꿈)
  const useKwCover = info.cover && (!cover || cover.source === 'kakaoWebtoon');
  return {
    title: main.title,
    author: main.author || '',
    type: main.type,
    cover: useKwCover ? info.cover : cover?.cover || '',
    coverSource: useKwCover ? '카카오웹툰' : cover ? SEARCH_SOURCES[cover.source].platform : '',
    platform: [...new Set(sorted.map((i) => SEARCH_SOURCES[i.source].platform))].join(', '),
    genre: info.genre || sorted.find((i) => i.genre)?.genre || '',
    ongoing: mergeOngoing([...sorted.map((i) => i.ongoing), info.ongoing]), // 연재중 / 완결
    desc: descs.sort((a, b) => b.length - a.length)[0] || '',
    tags: info.tags || [],
    links: sorted
      .map((i) => ({ name: SEARCH_SOURCES[i.source].platform, url: safeUrl(i.url || linkOf(i.source, i.sourceId)) }))
      .filter((l) => l.url),
    source: main.source,
    sourceId: main.sourceId,
    unit: main.unit || '',
  };
}

function openDetail(state) {
  detailState = state;
  lastHero = ''; // 다른 작품이니 표지를 새로 그림
  renderDetail();
  openOverlay('detailPage');
  $('detailPage').scrollTop = 0;

  if (state.group) loadGroupInfo(state);
  else fillMissingInfo(works.find((w) => w.id === state.workId));
}

// 장르·태그·연재 상태·소개를 가져올 대표 플랫폼 (앞에 있을수록 먼저, 카카오웹툰은 태그가 없어서 맨 뒤)
const INFO_SOURCES = ['naverWebtoon', 'kakao', 'seriesNovel', 'seriesComic', 'mrblue', 'naverBest', 'naverChallenge', 'kakaoWebtoon'];

// 플랫폼 정보 여러 개를 하나로 합침
function mergeInfo(results) {
  const info = {};
  for (const r of results) {
    if (!r) continue;
    if (r.cover) info.cover = r.cover;
    if (r.genre && !info.genre) info.genre = r.genre;
    if (r.tags?.length && !info.tags?.length) info.tags = r.tags;
    if (r.desc && r.desc.length > (info.desc || '').length) info.desc = r.desc;
    info.ongoing = mergeOngoing([info.ongoing, r.ongoing]);
  }
  return info;
}

// 검색 결과의 작품 정보 더 불러오기 (정보 화면을 열 때 한 번만)
// - 대표 플랫폼 한 곳: 장르·태그·연재 상태·소개
// - 카카오웹툰이 있으면 같이: 대표 이미지 + 전체 소개 + 연재 상태
async function loadGroupInfo(state) {
  const items = state.group.items;
  const main = INFO_SOURCES.map((s) => items.find((i) => i.source === s)).find(Boolean);
  const kw = items.find((i) => i.source === 'kakaoWebtoon');
  const targets = [...new Set([main, kw].filter(Boolean))];
  if (!targets.length) return;

  // 불러오는 동안은 흰 화면에 로딩 표시만 - 작품 정보와 표지 그림까지 다 받은 뒤에 화면을 보여줌
  // (너무 오래 걸리면 8초 뒤 있는 것만으로 보여줌)
  state.loading = true;
  renderDetail();
  const tooLong = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
  const results = await Promise.race([
    Promise.allSettled(targets.map((i) => SEARCH_SOURCES[i.source].fetchInfo(i))),
    tooLong,
  ]);
  if (detailState !== state) return; // 그사이 화면을 닫았으면 무시
  state.info = mergeInfo((results || []).map((r) => (r.status === 'fulfilled' ? r.value : null)));
  if (results) await Promise.race([preloadImage(groupAsWork(state.group, state.info).cover), tooLong]);
  if (detailState !== state) return;
  state.loading = false;
  renderDetail();
}

// 그림을 미리 받아 둠 (실패해도 그냥 넘어감)
function preloadImage(src) {
  if (!src) return Promise.resolve();
  const img = new Image();
  img.src = src;
  return img.decode().catch(() => {});
}

// 내 서재 작품에 장르·태그·연재 상태·소개가 비어 있으면 (예전에 담은 작품) 한 번 불러와서 채워 넣음
const infoTried = new Set();
async function fillMissingInfo(w) {
  if (!w || !w.source || infoTried.has(w.id)) return;
  if (w.desc && w.genre && w.ongoing && w.tags?.length) return;
  infoTried.add(w.id);
  const src = SEARCH_SOURCES[w.source];
  if (!src?.fetchInfo) return;
  try {
    const mrblueUrl = workLinks(w).find((l) => /mrblue\.com/.test(l.url))?.url;
    const found = mergeInfo([await src.fetchInfo({ sourceId: w.sourceId, url: mrblueUrl })]);
    const now = works.find((x) => x.id === w.id);
    if (!now) return;
    // 빈 칸만 채움 ('최근 수정' 순서는 그대로 둠)
    const work = {
      ...now,
      desc: now.desc || found.desc || '',
      genre: now.genre || found.genre || '',
      ongoing: found.ongoing || now.ongoing || '',
      tags: now.tags?.length ? now.tags : (found.tags || []),
    };
    await saveOne(work);
    works = works.map((x) => (x.id === w.id ? work : x));
    if (detailState?.workId === w.id) renderDetail();
  } catch { /* 못 불러와도 그 칸만 비어 있음 */ }
}

// 작품 정보 화면 그리기
// 표지 부분은 바뀔 때만 다시 그림 (+1 / 별점을 누를 때마다 표지가 깜빡이지 않게)
let lastHero = '';
function renderDetail() {
  if (!detailState) return;
  const mine = detailState.workId ? works.find((w) => w.id === detailState.workId) : null;
  if (detailState.workId && !mine) return;
  if (detailState.loading) {
    $('detailHero').innerHTML = '';
    $('detailBody').innerHTML = '<div class="detail-loading" role="status" aria-label="불러오는 중"><span class="spinner"></span></div>';
    lastHero = '';
    return;
  }
  const w = mine || groupAsWork(detailState.group, detailState.info);
  const hero = heroHTML(w);
  if (hero !== lastHero) {
    $('detailHero').innerHTML = hero;
    lastHero = hero;
  }
  $('detailBody').innerHTML = detailHTML(w, mine);
}

function heroHTML(w) {
  return `
    <div class="hero">
      ${w.cover ? `<img class="hero-bg" src="${esc(w.cover)}" alt="" onerror="this.remove()">` : ''}
      <div class="hero-cover">${coverHTML(w, 'cover').replace(' loading="lazy"', '')}</div>
    </div>`;
}

// 맨 아래 출처: 표지는 플랫폼에서 가져온 것만 표시 (직접 고른 사진은 표시 안 함)
function sourceHTML(w) {
  const cover = w.coverSource || (w.cover && !w.cover.startsWith('data:') && SEARCH_SOURCES[w.source]?.platform) || '';
  const lines = [
    cover && `이미지 출처 · ${esc(cover)}`,
    w.platform && `정보 출처 · ${esc(w.platform)}`,
  ].filter(Boolean);
  return lines.length ? `<p class="detail-source">${lines.join('<br>')}</p>` : '';
}

// 표지 아래 부분 (작품명·내 기록·소개·보러 가기)
function detailHTML(w, mine) {
  const links = workLinks(w);
  return `
    <div class="detail-info">
      <p class="kicker">${esc([TYPES[w.type], w.platform].filter(Boolean).join(' · '))}</p>
      <h2 class="detail-title">${esc(w.title)}</h2>
      <p class="detail-author">${esc([uniqueAuthors(w.author), w.genre, w.ongoing].filter(Boolean).join(' · '))}</p>
      ${socialStatsHTML()}
    </div>

    ${mine ? myRecordHTML(mine) : preRecordHTML()}

    ${w.desc ? `
      <div class="detail-sec">
        <h3>작품 소개</h3>
        <p class="detail-desc">${esc(w.desc)}</p>
      </div>` : ''}

    ${w.tags?.length ? `
      <div class="detail-sec">
        <h3>키워드</h3>
        <div class="tag-list">${w.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
      </div>` : ''}

    ${links.length ? `
      <div class="detail-sec">
        <h3>보러 가기</h3>
        <div class="pf-buttons">
          ${links.map((l) => `
            <a class="pf-btn go-link" href="${esc(l.url)}" target="_blank" rel="noopener">
              ${pfIconHTML(l.name)}<span>${esc(l.name)}</span>
            </a>`).join('')}
        </div>
      </div>` : ''}

    ${mine ? `
      <div class="detail-tools">
        <button type="button" class="link danger-link" data-remove>서재에서 빼기</button>
      </div>` : ''}

    <p class="detail-note">작품 정보와 표지는 각 플랫폼에서 가져왔어요. 작품은 해당 플랫폼에서 볼 수 있어요.</p>
    ${sourceHTML(w)}

    ${mine ? '' : `
      <div class="detail-cta">
        <button type="button" class="primary wide" id="detailAdd">내 서재에 담기</button>
      </div>`}`;
}

// 다른 사람들의 별점·한줄평 수 (웹소소처럼 제목 아래)
// 아직 별점·한줄평을 모아 두는 서버가 없어서 자리만 있음 - 서버를 만들면 stats 에 { rating, ratingCount, reviewCount } 를 넣어 줌
function socialStatsHTML(stats = null) {
  const star = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2.8 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>';
  const bubble = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>';
  const rating = stats?.ratingCount ? `${stats.rating.toFixed(1)} <small>(${stats.ratingCount})</small>` : '아직 별점 없음';
  return `
    <div class="detail-stats">
      <span>${star}${rating}</span>
      <span>${bubble}한줄평 ${stats?.reviewCount || 0}</span>
    </div>`;
}

// 담기 전 기록 버튼: 별점 / 보는 중 / 완독 / 하차 - 누르면 그대로 서재에 담김
function preRecordHTML() {
  return `
    <div class="pre-record">
      <button type="button" class="pre-rate" data-open-rating>
        <span class="rate-ico">★</span> 별점 남기기
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
      </button>
      <div class="pre-status">
        ${['reading', 'done', 'dropped'].map((key) => `
          <button type="button" class="st-${key}" data-pre-status="${key}">
            ${STATUS_INFO[key].icon}<span>${STATUSES[key]}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

// 내 기록: 상태 / 별점 / 본 회차 / 한줄평 (누르면 바로 저장)
function myRecordHTML(w) {
  const unit = unitOf(w.type, w.unit);
  return `
    <div class="record">
      <!-- 누르면 상태 선택 창 / 별점 창이 아래에서 올라옴 -->
      <div class="record-top">
        <button type="button" class="record-btn status-btn st-${w.status}" data-open-status>
          <span class="record-ico">${STATUS_INFO[w.status].icon}</span>
          <span class="record-txt"><small>내 상태</small><b>${STATUSES[w.status]}</b></span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <button type="button" class="record-btn rate-btn${w.rating ? ' rated' : ''}" data-open-rating>
          <span class="record-ico rate-ico">★</span>
          <span class="record-txt"><small>내 별점</small><b>${w.rating ? w.rating.toFixed(1) : '남기기'}</b></span>
        </button>
      </div>

      <div class="record-row progress-row">
        <span class="record-label">마지막 본 회차</span>
        <div class="stepper">
          <button type="button" data-step="-1" aria-label="한 ${unit} 빼기">−</button>
          <input type="number" id="detailProgress" min="0" max="99999" inputmode="numeric" value="${w.progress || 0}" aria-label="마지막 본 회차">
          <button type="button" data-step="1" aria-label="한 ${unit} 더하기">+</button>
        </div>
        <!-- 연재본은 화, 단행본은 권 (누르면 바로 저장) -->
        <span class="unit-toggle" role="group" aria-label="회차 단위">
          ${['화', '권'].map((u) => `<button type="button" data-unit="${u}" class="${unit === u ? 'active' : ''}">${u}</button>`).join('')}
        </span>
      </div>

      ${w.review
        ? `<button type="button" class="review-card" data-review>
             <span class="review-text">${esc(w.review)}</span>
             <span class="review-edit">수정</span>
           </button>`
        : `<button type="button" class="review-btn" data-review>
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>
             한줄평 쓰기
           </button>`}
    </div>`;
}

// 내 서재 작품 고쳐서 저장 (작품 정보 화면에서 바로)
async function updateWork(id, patch) {
  const old = works.find((w) => w.id === id);
  if (!old) return;
  const work = { ...old, ...patch, updatedAt: Date.now() };
  // '완독'으로 바꾸고 다 본 날이 비어 있으면 오늘 날짜를 넣어줌
  if (work.status === 'done' && !work.finishedAt) work.finishedAt = new Date().toLocaleDateString('sv-SE');
  await saveOne(work);
  works = works.map((w) => (w.id === id ? work : w));
  render();
}

// "내 서재에 담기": 검색해서 가져온 정보 그대로 바로 저장 (보는 중, 오늘 시작)
// record: 담기 전에 고른 상태·별점 (예: { status: 'done' }, { rating: 4 })
async function addFromGroup(group, info, record = {}) {
  const w = groupAsWork(group, info);
  const now = Date.now();
  const today = new Date().toLocaleDateString('sv-SE');
  const work = {
    ...w,
    id: newId(),
    status: 'reading',
    review: '',
    progress: 0,
    latest: 0,
    rating: 0,
    startedAt: today,
    finishedAt: '',
    createdAt: now,
    updatedAt: now,
    ...record,
  };
  if (work.status === 'done') work.finishedAt = today;
  await saveOne(work);
  works = [...works, work];
  detailState = { workId: work.id };
  render();
  toast('서재에 담았어요');
}

async function removeWork(id) {
  const work = works.find((w) => w.id === id);
  if (!work || !confirm(`'${work.title}'을(를) 서재에서 뺄까요?`)) return;
  await deleteOne(id);
  works = works.filter((w) => w.id !== id);
  closeOverlay();
  render();
}

// 상태 선택 창 (웹소소처럼 아래에서 올라오는 목록)
const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const STATUS_INFO = {
  reading: { desc: '지금 보고 있어요', icon: ICON('<path d="M3 5.5C5 4.5 8 4.5 12 6.5c4-2 7-2 9-1V19c-2-1-5-1-9 1-4-2-7-2-9-1z"/><path d="M12 6.5V20"/>') },
  done: { desc: '끝까지 다 봤어요', icon: ICON('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>') },
  paused: { desc: '잠시 쉬는 중이에요', icon: ICON('<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>') },
  dropped: { desc: '그만 보기로 했어요', icon: ICON('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>') },
};

function openStatusSheet() {
  const w = works.find((x) => x.id === detailState?.workId);
  if (!w) return;
  $('statusList').innerHTML = Object.entries(STATUSES).map(([key, label]) => `
    <button type="button" class="status-option st-${key}${w.status === key ? ' active' : ''}" data-status="${key}">
      <span class="record-ico">${STATUS_INFO[key].icon}</span>
      <span class="record-txt"><b>${label}</b><small>${STATUS_INFO[key].desc}</small></span>
      ${w.status === key ? '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : ''}
    </button>`).join('');
  $('statusSheet').showModal();
}

// 상태를 고르면 저장하고, 처음으로 완독하면 바로 별점 창을 띄움
async function pickStatus(status) {
  const w = works.find((x) => x.id === detailState?.workId);
  $('statusSheet').close();
  if (!w || w.status === status) return;
  await updateWork(w.id, { status });
  if (status === 'done' && !w.rating) openRating(true);
}

// 별점 창: 큰 별 5개 (누르거나 밀어서 0.5점 단위로)
const RATING_WORDS = { 0.5: '최악이에요', 1: '싫어요', 1.5: '재미없어요', 2: '별로예요', 2.5: '부족해요', 3: '보통이에요', 3.5: '볼만해요', 4: '재밌어요', 4.5: '훌륭해요', 5: '최고예요!' };
let sheetRating = 0;

function openRating(justFinished = false) {
  // 아직 서재에 없는 작품이면 검색 결과 정보로 (별점을 고르면 그때 서재에 담김)
  const w = works.find((x) => x.id === detailState?.workId)
    || (detailState?.group && groupAsWork(detailState.group, detailState.info));
  if (!w) return;
  $('ratingTitle').textContent = justFinished ? '다 보셨군요! 어떠셨나요?' : '이 작품, 어떠셨나요?';
  $('ratingWork').textContent = w.title;
  $('ratingSheetClear').hidden = !w.rating;
  setSheetRating(w.rating || 0);
  $('ratingSheet').showModal();
}

function setSheetRating(value) {
  sheetRating = value;
  $('ratingSheetStars').innerHTML = starsHTML(value);
  $('ratingWord').innerHTML = value
    ? `<b>${value.toFixed(1)}</b> ${RATING_WORDS[value]}`
    : '별을 눌러서 점수를 매겨 주세요';
}

// 별 위의 손가락 위치 → 0.5 ~ 5점
function ratingAt(starsEl, clientX) {
  const rect = starsEl.getBoundingClientRect();
  const ratio = (clientX - rect.left) / rect.width;
  return Math.min(5, Math.max(0.5, Math.ceil(ratio * 10) / 2));
}

// 큰 별 위를 누르거나 밀면 onChange(점수)를 부름 (별점 창, 한줄평 쓰기 화면에서 같이 씀)
function bindStarDrag(starsEl, onChange) {
  let dragging = false;
  starsEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    starsEl.setPointerCapture(e.pointerId);
    onChange(ratingAt(starsEl, e.clientX));
  });
  starsEl.addEventListener('pointermove', (e) => { if (dragging) onChange(ratingAt(starsEl, e.clientX)); });
  starsEl.addEventListener('pointerup', () => { dragging = false; });
  starsEl.addEventListener('pointercancel', () => { dragging = false; });
}


// ----- 6-6. 한줄평 쓰기 화면 (작품 정보의 "한줄평 쓰기" / 피드의 ＋) -----
// workId: 한줄평을 남길 작품 (피드에서 열면 비어 있어서 먼저 내 서재에서 고름)
// fixed: 작품 정보 화면에서 열었으면 작품을 바꿀 수 없음
let reviewState = { workId: null, fixed: false, rating: 0 };

function openReviewPage(workId = null) {
  reviewState = { workId, fixed: !!workId, rating: 0 };
  $('pickerQuery').value = '';
  openOverlay('reviewPage');
  $('reviewPage').scrollTop = 0;
  // 키보드는 입력칸을 직접 눌렀을 때만 올라오게 (열자마자 올라오면 화면이 밀림)
  if (workId) {
    showReviewEditor();
  } else {
    showPicker();
  }
}

// 고른 작품 카드 + 별점 + 한줄평 입력칸
function showReviewEditor() {
  const w = works.find((x) => x.id === reviewState.workId);
  if (!w) { showPicker(); return; }
  $('reviewPicker').hidden = true;
  $('reviewEditor').hidden = false;
  $('reviewWorkBox').innerHTML = `
    <button type="button" class="review-work" ${reviewState.fixed ? 'disabled' : 'data-change'}>
      ${coverHTML(w, 'thumb')}
      <span class="item-body">
        <span class="kicker">${esc([TYPES[w.type], w.platform].filter(Boolean).join(' · '))}</span>
        <span class="review-work-title">${esc(w.title)}</span>
        <span class="author">${esc(uniqueAuthors(w.author))}</span>
      </span>
      ${reviewState.fixed ? '' : '<span class="review-change">변경</span>'}
    </button>`;
  $('reviewInput').value = w.review || '';
  $('reviewSpoiler').checked = !!w.reviewSpoiler;
  $('reviewDelete').hidden = !w.review;
  setReviewRating(w.rating || 0);
  updateReviewCount();
}

// 내 서재에서 작품 고르기 (피드에서 열었을 때)
function showPicker() {
  $('reviewPicker').hidden = false;
  $('reviewEditor').hidden = true;
  $('reviewWorkBox').innerHTML = '';
  renderPicker();
  updateReviewCount();
}

function renderPicker() {
  const q = $('pickerQuery').value.trim().toLowerCase();
  const list = [...works]
    .filter((w) => !q || [w.title, w.author].some((t) => (t || '').toLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  $('pickerList').innerHTML = list.length
    ? list.map((w) => `
        <button type="button" class="pick-item" data-id="${esc(w.id)}">
          ${coverHTML(w, 'thumb')}
          <span class="item-body">
            <span class="review-work-title">${esc(w.title)}</span>
            <span class="author">${esc([uniqueAuthors(w.author), TYPES[w.type]].filter(Boolean).join(' · '))}</span>
          </span>
          ${w.review ? '<span class="has-review">한줄평 있음</span>' : ''}
        </button>`).join('')
    : `<p class="hint">${works.length ? '찾는 작품이 없어요.' : '서재가 비어 있어요. 먼저 작품을 검색해서 담아 주세요.'}</p>`;
}

function setReviewRating(value) {
  reviewState.rating = value;
  $('reviewStars').innerHTML = starsHTML(value);
  $('reviewWord').innerHTML = value
    ? `<b>${value.toFixed(1)}</b> ${RATING_WORDS[value]}`
    : '별점도 함께 남겨 주세요';
}

// 글자 수 + "등록" 버튼 (작품을 고르고 한 글자라도 써야 누를 수 있음)
function updateReviewCount() {
  const text = $('reviewInput').value;
  $('reviewCount').textContent = `${text.length}/100`;
  $('reviewSave').disabled = !reviewState.workId || $('reviewEditor').hidden || !text.trim();
}

async function saveReview() {
  const id = reviewState.workId;
  const review = $('reviewInput').value.trim().slice(0, 100);
  if (!id || !review) return;
  await updateWork(id, { review, reviewSpoiler: $('reviewSpoiler').checked, rating: reviewState.rating });
  closeOverlay();
  toast('한줄평을 남겼어요');
}

async function deleteReview() {
  const id = reviewState.workId;
  if (!id || !confirm('한줄평을 지울까요?')) return;
  await updateWork(id, { review: '', reviewSpoiler: false });
  closeOverlay();
}

// 화면 아래에 잠깐 뜨는 알림
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 1800);
}


// ----- 6-7. 전체 화면 창 (검색, 작품 정보, 한줄평 쓰기) -----
// 열 때마다 방문 기록을 하나 남겨서, 휴대폰의 뒤로 가기로 닫히게 함
const overlayStack = [];

function openOverlay(id) {
  if (overlayStack[overlayStack.length - 1] === id) return;
  $(id).hidden = false;
  overlayStack.push(id);
  // 나중에 연 창이 항상 위에 (검색 → 작품 찾기 → 검색 결과처럼 순서가 바뀌어도)
  $(id).style.zIndex = 30 + overlayStack.length;
  lockPage(true);
  history.pushState({ overlay: id }, '');
}

function closeOverlay() {
  history.back();
}

window.addEventListener('popstate', () => {
  const id = overlayStack.pop();
  // 같은 창이 아래에 또 열려 있으면(검색 → 작품 찾기 → 검색 결과) 닫지 않고 원래 높이로만 내림
  if (id && overlayStack.includes(id)) $(id).style.zIndex = 30 + overlayStack.lastIndexOf(id) + 1;
  else if (id) $(id).hidden = true;
  if (id === 'detailPage') detailState = null;
  if (!overlayStack.length) lockPage(false);
});

// 전체 화면 창이 열려 있는 동안 뒤의 화면을 고정 (아이폰은 키보드가 올라올 때 뒤 화면까지 밀어 올려서)
let lockedScrollY = 0;
function lockPage(lock) {
  const locked = document.body.classList.contains('overlay-open');
  if (lock === locked) return;
  if (lock) {
    lockedScrollY = window.scrollY;
    document.body.style.top = `-${lockedScrollY}px`;
    document.body.classList.add('overlay-open');
  } else {
    document.body.classList.remove('overlay-open');
    document.body.style.top = '';
    window.scrollTo(0, lockedScrollY);
  }
}


// 모든 입력칸: 누를 때 아이폰이 입력칸을 보이게 하려고 화면을 밀어 올리지 않게 함
// (터치를 직접 받아서 "화면을 움직이지 말고" 입력칸에 커서만 넣음 → 키보드는 화면 위에 겹쳐서 올라옴)
const TYPING_INPUTS = ['text', 'search', 'number', 'url', 'email', 'tel', 'password'];
const isTypingField = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TYPING_INPUTS.includes(el.type)));

document.addEventListener('touchend', (e) => {
  const field = e.target.closest('input, textarea');
  if (!isTypingField(field) || document.activeElement === field) return; // 이미 쓰는 중이면 커서 옮기기 등은 그대로
  e.preventDefault();
  field.focus({ preventScroll: true });
}, { passive: false });

// 그래도 밀려 올라갔으면 (오래된 아이폰 등) 바로 제자리로 - 전체 화면 창이나 아래에서 올라오는 창이 열려 있을 때
if (window.visualViewport) {
  window.visualViewport.addEventListener('scroll', () => {
    const fixedOpen = overlayStack.length || document.querySelector('dialog[open]');
    if (fixedOpen && window.visualViewport.offsetTop > 0) window.scrollTo(0, 0);
  });
}

// 아이폰은 user-scalable=no 를 무시하고 두 손가락 확대를 허용해서, 확대 동작 자체를 막음
['gesturestart', 'gesturechange'].forEach((type) => {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
});


// ----- 7. 백업 / 복원 -----
function exportBackup() {
  const data = { app: 'my-library', version: 1, exportedAt: new Date().toISOString(), nickname: nicknameNow, works };
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

    const valid = list.map(fixType).filter((w) => w && w.id && w.title && TYPES[w.type] && STATUSES[w.status]);
    if (!confirm(`백업 파일에서 ${valid.length}개 작품을 불러올게요.\n같은 작품이 이미 있으면 백업 내용으로 바뀌어요.`)) return;

    for (const w of valid) await saveOne(w);
    if (!nicknameNow && typeof data.nickname === 'string') setNickname(data.nickname.slice(0, 12));
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

  // 카드 누르면 작품 정보 화면 열기
  const onCardClick = (e) => {
    if (e.target.closest('.go-link')) return; // 플랫폼 아이콘은 링크만 열고 정보 화면은 안 엶
    const plus = e.target.closest('.plus-btn');
    if (plus) { addProgress(plus.dataset.id); return; }
    const card = e.target.closest('.card');
    if (card) openDetail({ workId: card.dataset.id });
  };
  $('grid').addEventListener('click', onCardClick);
  $('calDayList').addEventListener('click', onCardClick);
  $('recentList').addEventListener('click', onCardClick);
  // 피드: 스포일러 한줄평은 한 번 누르면 보이고, 그다음부터는 작품 정보로
  $('feedList').addEventListener('click', (e) => {
    const spoiler = e.target.closest('.is-spoiler');
    if (spoiler) { spoiler.classList.remove('is-spoiler'); return; }
    onCardClick(e);
  });

  // 홈 검색창 / ＋ 버튼: 검색 화면 열기
  $('homeSearch').addEventListener('click', () => openSearch());

  // 작품 찾기: 장르는 하나만, 종류·플랫폼은 여러 개, 연재 상태는 하나 (다시 누르면 해제)
  $('finderBanner').addEventListener('click', openFinder);
  $('finderBack').addEventListener('click', closeOverlay);
  $('finderPage').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    const { pick, value } = btn.dataset;
    if (pick === 'genre' || pick === 'ongoing') {
      finderPick[pick] = finderPick[pick] === value ? '' : value;
    } else {
      const set = finderPick[pick];
      if (set.has(value)) set.delete(value); else set.add(value);
    }
    renderFinder();
  });
  $('finderReset').addEventListener('click', () => {
    finderPick = { genre: '', types: new Set(), platforms: new Set(), ongoing: '' };
    renderFinder();
  });
  $('finderRun').addEventListener('click', runFinder);
  // ＋ 버튼: 피드에서는 한줄평 쓰기, 나머지 화면에서는 작품 검색
  $('addBtn').addEventListener('click', () => (view.mode === 'feed' ? openReviewPage() : openSearch()));

  // 검색 화면
  $('searchBack').addEventListener('click', closeOverlay);
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('s-query').value); });
  $('s-query').addEventListener('input', (e) => { if (!e.target.value.trim()) showSearchIntro(); });
  $('searchIntro').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      saveRecentSearches(recentSearches().filter((k) => k !== remove.dataset.remove));
      showSearchIntro();
      return;
    }
    // 장르 아이콘: 그 장르만 골라서 바로 작품 찾기 / "장르별 검색 >": 작품 찾기 화면
    const genre = e.target.closest('[data-genre]');
    if (genre) {
      finderPick = { genre: genre.dataset.genre, types: new Set(), platforms: new Set(), ongoing: '' };
      runFinder();
      return;
    }
    if (e.target.closest('#genreMore')) { openFinder(); return; }
    const word = e.target.closest('[data-q]');
    if (word) runSearch(word.dataset.q);
    if (e.target.closest('#recentClear')) { saveRecentSearches([]); showSearchIntro(); }
    if (e.target.closest('#manualAdd')) openEditor(null);
  });
  $('s-results').addEventListener('click', (e) => {
    if (e.target.closest('#s-more')) { searchPlatform(true); return; }
    // 종류 / 플랫폼 필터
    const filter = e.target.closest('[data-filter]');
    if (filter) { searchState.filter[filter.dataset.filter] = filter.dataset.value; renderSearchResults(); return; }
    const item = e.target.closest('.s-item');
    if (!item) return;
    const group = searchState.groups.get(item.dataset.key);
    const mine = findInLibrary(group);
    openDetail(mine ? { workId: mine.id } : { group });
  });

  // 작품 정보 화면: 내 기록은 누르는 즉시 저장
  $('detailBack').addEventListener('click', closeOverlay);
  $('detailBody').addEventListener('click', async (e) => {
    const id = detailState?.workId;
    if (e.target.closest('#detailAdd')) { addFromGroup(detailState.group, detailState.info); return; }
    // 담기 전: 상태를 누르면 그 상태로 서재에 담음 (완독이면 바로 별점 창)
    const pre = e.target.closest('[data-pre-status]');
    if (pre && !id) {
      const status = pre.dataset.preStatus;
      await addFromGroup(detailState.group, detailState.info, { status });
      if (status === 'done') openRating(true);
      return;
    }
    if (e.target.closest('[data-open-rating]') && !id) { openRating(); return; }
    if (!id) return;
    const work = works.find((w) => w.id === id);

    if (e.target.closest('[data-open-status]')) { openStatusSheet(); return; }
    if (e.target.closest('[data-open-rating]')) { openRating(); return; }

    const unitBtn = e.target.closest('[data-unit]');
    if (unitBtn) { if (unitOf(work.type, work.unit) !== unitBtn.dataset.unit) updateWork(id, { unit: unitBtn.dataset.unit }); return; }

    const step = e.target.closest('[data-step]');
    if (step) { updateWork(id, { progress: Math.max(0, (work.progress || 0) + Number(step.dataset.step)) }); return; }

    if (e.target.closest('[data-review]')) openReviewPage(id);
    if (e.target.closest('[data-remove]')) removeWork(id);
  });
  // 본 회차 직접 입력: 다 쓰고 나면(엔터나 다른 곳 누르기) 저장
  $('detailBody').addEventListener('change', (e) => {
    if (e.target.id !== 'detailProgress' || !detailState?.workId) return;
    updateWork(detailState.workId, { progress: Math.max(0, Math.floor(Number(e.target.value) || 0)) });
  });
  $('detailBody').addEventListener('keydown', (e) => {
    if (e.target.id === 'detailProgress' && e.key === 'Enter') e.target.blur();
  });

  // 상태 선택 창
  $('statusList').addEventListener('click', (e) => {
    const option = e.target.closest('[data-status]');
    if (option) pickStatus(option.dataset.status);
  });

  // 별점 창: 누르거나 별 위를 밀면 점수가 바뀜
  bindStarDrag($('ratingSheetStars'), setSheetRating);
  $('ratingSheetCancel').addEventListener('click', () => $('ratingSheet').close());
  $('ratingSheetClear').addEventListener('click', async () => {
    await updateWork(detailState.workId, { rating: 0 });
    $('ratingSheet').close();
  });
  $('ratingSheetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!detailState?.workId) {
      // 담기 전에 별점부터 남기면: 보는 중 + 그 별점으로 서재에 담음 (별을 안 골랐으면 아무것도 안 함)
      if (sheetRating) await addFromGroup(detailState.group, detailState.info, { rating: sheetRating });
      $('ratingSheet').close();
      return;
    }
    await updateWork(detailState.workId, { rating: sheetRating });
    $('ratingSheet').close();
  });

  // 시트 바깥(어두운 부분)을 누르면 닫기
  ['statusSheet', 'ratingSheet'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).close(); });
  });

  // 한줄평 쓰기 화면
  $('reviewClose').addEventListener('click', closeOverlay);
  $('reviewSave').addEventListener('click', saveReview);
  $('reviewDelete').addEventListener('click', deleteReview);
  $('reviewInput').addEventListener('input', updateReviewCount);
  bindStarDrag($('reviewStars'), setReviewRating);
  $('pickerQuery').addEventListener('input', renderPicker);
  $('pickerList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    $('pickerQuery').blur(); // 작품을 고르면 키보드 내리기
    reviewState.workId = item.dataset.id;
    showReviewEditor();
  });
  $('reviewWorkBox').addEventListener('click', (e) => {
    if (e.target.closest('[data-change]')) showPicker();
  });

  // 홈 "전체 보기": 서재 화면으로 이동
  document.querySelectorAll('.sec-head .more').forEach((btn) => btn.addEventListener('click', () => {
    view.status = 'all';
    $('statusFilter').value = view.status;
    render();
    setViewMode('library');
  }));

  // 카드형 / 리스트 전환
  $('layoutToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    view.layout = btn.dataset.layout;
    try { localStorage.setItem('layout', view.layout); } catch { /* 저장 못 해도 지금 화면은 바뀜 */ }
    render();
  });

  // 홈 / 서재 / 피드 / 캘린더 / 설정 전환
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

  // 입력 창
  $('workForm').addEventListener('submit', handleSubmit);
  $('f-type').addEventListener('change', updateProgressUnit);
  $('f-unit').addEventListener('change', () => { unitPicked = true; });
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

  // 설정: 닉네임 저장
  $('nickForm').addEventListener('submit', (e) => {
    e.preventDefault();
    setNickname($('nickInput').value.trim().slice(0, 12));
    $('nickInput').value = nicknameNow;
    $('nickInput').blur(); // 키보드 내리기
    render();
    toast('닉네임을 저장했어요');
  });

  // 설정: 백업 / 복원
  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importFile').click());
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
    // 예전에 '일본만화'로 담은 작품은 '만화'로 바꿔서 저장
    const old = works.filter((w) => w.type === 'manga');
    if (old.length) {
      for (const w of old) await saveOne(fixType(w));
      works = works.map(fixType);
    }
    await fixSavedManga();
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
