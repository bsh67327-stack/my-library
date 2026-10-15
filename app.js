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
  // mangaFix2: 판단 기준을 넓힌 뒤 한 번 더 (작가 한 명만 확실히 일본 이름이어도 만화로)
  try { if (localStorage.getItem('mangaFix2')) return; } catch { return; }
  const isManga = (w) => w.type === 'webtoon' && looksJapaneseAuthor(String(w.author || '').split(/[,/]/));
  const changed = works.filter(isManga).map((w) => ({ ...w, type: 'comic', unit: w.unit || '화' }));
  for (const w of changed) await saveOne(w);
  if (changed.length) works = works.map((w) => changed.find((c) => c.id === w.id) || w);
  try { localStorage.setItem('mangaFix2', '1'); } catch { /* 다음에 다시 시도 */ }
}
const STATUSES = { reading: '보는 중', done: '완독', paused: '보류', dropped: '하차' };

// 앱 버전 (홈 화면 제목 옆에 작게 표시 - index.html의 ?v= 숫자와 맞춰 주세요)
const APP_VERSION = 73;

// 작품 검색 중계 서버 주소 (Cloudflare Worker를 만든 뒤 여기에 붙여넣기)
const SEARCH_SERVER = 'https://my-library-search.bsh67327.workers.dev/';

// 화면 상태: 홈/서재/피드/캘린더 중 어떤 화면인지, 어떤 필터/정렬을 보고 있는지
// layout: 서재를 카드형(card) / 리스트(list) 중 무엇으로 볼지 (마지막에 고른 것을 기억)
// (책을 쌓은 모양은 홈 "최근 기록"으로 옮김)
const LAYOUTS = ['card', 'list'];
const view = { mode: 'home', layout: savedLayout(), type: 'all', status: 'all', genre: 'all', ongoing: 'all', rating: 'all', sort: 'updated', query: '' };

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
// 작가 중 한 명이라도 확실히 일본 이름이고, 나머지도 일본 필명일 수 있는 모양(받침 없는 한글 한 단어 "즈이노",
// 영문 한 단어 "ONE")이면 일본 만화로 봄 (예: "케이야마 케이, 즈이노" → 만화 / "LICO, 비가" → 확실한 일본 이름이 없어서 웹툰)
const noBatchimExceptN = (text) => [...text].every((ch) => [0, 4].includes((ch.charCodeAt(0) - 0xac00) % 28));
const isCompanyName = (n) =>
  /studio|animation|comics?|cartoon|toon|entertainment|media|works|team|group|production|company|literature|스튜디오|코믹스|엔터|미디어|컴퍼니/i.test(n);
// 일본어 로마자 모양의 영문 낱말 (Horikoshi, Sakurai, EIICHIRO 등 - l·v·x·c 없음, 끝 받침은 n 만)
// "Lee", "Payne", "Bill", "Changpan" 같은 영어·한국·중국 이름은 걸러짐
const ROMAJI_WORD = /^(?:(?:sh|ch|ts|[kgsztdnhbpmr]y|[kgszjtdnhfbpmyrw])?[aeiou]+|n(?![aeiou])|([kstp])(?=\1))+$/i;
const romajiName = (n) => n.split(' ').every((w) => w.replace(/[.'\-]/g, '').length >= 2 && ROMAJI_WORD.test(w.replace(/[.'\-]/g, '')));
const clearlyJapanese = (n) => (/^[A-Za-z.'\-]+( [A-Za-z.'\-]+)+$/.test(n) && romajiName(n)) ||
  (/^[가-힣]{2,5} [가-힣]{1,5}$/.test(n) && noBatchimExceptN(n.replace(' ', '')));
const maybeJapanese = (n) => clearlyJapanese(n) || (/^[가-힣]{2,5}$/.test(n) && noBatchimExceptN(n)) ||
  (/^[A-Za-z.'\-]+$/.test(n) && romajiName(n));
function looksJapaneseAuthor(names) {
  const list = names.map((n) => String(n).replace(/\([^)]*\)/g, '').trim()).filter(Boolean);
  return list.length > 0 && !list.some(isCompanyName) && list.some(clearlyJapanese) && list.every(maybeJapanese);
}

// 표지 그림을 못 불러오면(대부분 로그인해야 볼 수 있는 19세 작품) 같은 자리·같은 크기의 회색 칸에 "19세 이상 관람가"
// (표지가 원래 없는 작품은 여기로 오지 않고 제목 글자 칸 그대로)
// - 같은 작품의 다른 플랫폼 표지(data-alts)가 있으면 차례로 바꿔 보고, 모두 실패하면 회색 칸
// - 화면에 붙어 있지 않은 그림(다시 그리면서 버린 것)의 실패는 진짜 실패가 아니라서 무시
const failedCovers = new Set();
function coverError(img) {
  if (!img.isConnected) return;
  const src = img.getAttribute('src');
  if (src) failedCovers.add(src);
  const alts = (img.dataset.alts || '').split(' ').filter((u) => u && !failedCovers.has(u));
  if (alts.length) {
    img.dataset.alts = alts.slice(1).join(' ');
    img.src = alts[0];
    return;
  }
  const box = document.createElement('span');
  box.className = 'blocked-cover';
  box.dataset.src = src || '';
  box.textContent = '19세 이상 관람가';
  img.replaceWith(box);
}

// 목록을 다시 그려도 화면에 이미 있던 표지 그림(같은 주소)은 새로 만들지 않고 그대로 옮겨 씀
// - 다 받은 그림은 그대로, 받는 중이던 그림은 이어서 받음 → 새로 들어온 작품만 새로 받아서 표지가 깜빡이지 않음
// (새 HTML은 화면 밖 <template> 안에서 만들어서, 버릴 그림은 아예 받지 않음)
function setHTMLKeepImages(el, html) {
  const old = new Map();
  el.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (!old.has(src)) old.set(src, img);
  });
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    const prev = old.get(src);
    if (prev) {
      old.delete(src);
      prev.className = img.className;
      img.replaceWith(prev);
      return;
    }
    // 전에 못 불러온 표지는 다른 플랫폼 표지부터 (없으면 화면에 붙인 뒤 회색 칸으로)
    if (failedCovers.has(src)) {
      const alt = (img.dataset.alts || '').split(' ').find((u) => u && !failedCovers.has(u));
      if (alt) img.setAttribute('src', alt);
    }
  });
  el.replaceChildren(tpl.content);
  el.querySelectorAll('img[src]').forEach((img) => { if (failedCovers.has(img.getAttribute('src'))) coverError(img); });
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
  lezhin: (alias) => `https://www.lezhin.com/ko/comic/${encodeURIComponent(alias)}`,
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

  // (1) 거르기 (종류 · 읽기 상태 · 장르 · 연재 상태 · 별점 · 검색어)
  let list = works.filter((w) =>
    Object.keys(LIB_FILTERS).every((key) => view[key] === 'all' || LIB_FILTERS[key].match(w, view[key])) &&
    (!q || [w.title, w.author, w.review, w.platform].some((t) => (t || '').toLowerCase().includes(q)))
  );

  // (2) 정렬하기
  list.sort((LIB_SORTS.find((s) => s.key === view.sort) || LIB_SORTS[0]).cmp);

  // (3) 카드형 / 리스트로 그리기
  $('libCount').textContent = list.length || '';
  $('libTotal').textContent = `${list.length}개`;
  renderLibFilters();
  $('grid').className = `layout-${view.layout}`;
  setHTMLKeepImages($('grid'), list.map(view.layout === 'card' ? cardHTML : rowHTML).join(''));
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

// 서재 필터: 칩을 누르면 아래에서 고르는 창이 올라옴 ('all' = 전체)
// options() 는 [값, 이름] 목록, match(작품, 값) 은 그 값에 맞는지
const LIB_FILTERS = {
  type: {
    label: '종류',
    options: () => Object.entries(TYPES),
    match: (w, v) => w.type === v,
  },
  status: {
    label: '읽기 상태',
    options: () => Object.entries(STATUSES),
    match: (w, v) => w.status === v,
  },
  // 장르는 서재에 있는 작품들의 장르로 (많은 순)
  genre: {
    label: '장르',
    options: () => {
      const count = {};
      works.forEach((w) => { if (w.genre) count[w.genre] = (count[w.genre] || 0) + 1; });
      return Object.keys(count).sort((a, b) => count[b] - count[a]).map((g) => [g, g]);
    },
    match: (w, v) => w.genre === v,
  },
  ongoing: {
    label: '연재 상태',
    options: () => [['연재중', '연재중'], ['완결', '완결'], ['none', '정보 없음']],
    match: (w, v) => (v === 'none' ? !w.ongoing : v === '완결' ? /완결/.test(w.ongoing || '') : w.ongoing === v),
  },
  rating: {
    label: '별점',
    options: () => [['5', '5점'], ['4', '4점 이상'], ['3', '3점 이상'], ['low', '3점 미만'], ['none', '별점 없음']],
    match: (w, v) => {
      const r = w.rating || 0;
      return v === 'none' ? !r : v === 'low' ? r > 0 && r < 3 : r >= Number(v);
    },
  },
};

// 서재 정렬
const LIB_SORTS = [
  { key: 'updated', label: '최근 수정순', cmp: (a, b) => b.updatedAt - a.updatedAt },
  { key: 'created', label: '등록 최신순', cmp: (a, b) => b.createdAt - a.createdAt },
  { key: 'createdOld', label: '등록 오래된순', cmp: (a, b) => a.createdAt - b.createdAt },
  { key: 'title', label: '제목순', cmp: (a, b) => a.title.localeCompare(b.title, 'ko') },
  { key: 'rating', label: '별점 높은순', cmp: (a, b) => (b.rating || 0) - (a.rating || 0) || b.updatedAt - a.updatedAt },
  { key: 'ratingLow', label: '별점 낮은순', cmp: (a, b) => (a.rating || 0) - (b.rating || 0) || b.updatedAt - a.updatedAt },
];

const CHEVRON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>';
const CHECK = '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

// 필터 칩 (고른 게 있으면 그 이름을 보여주고 색을 칠함)
function renderLibFilters() {
  $('libFilters').innerHTML = Object.entries(LIB_FILTERS).map(([key, f]) => {
    const picked = view[key] !== 'all' && f.options().find(([v]) => v === view[key]);
    return `<button type="button" class="lf-chip${picked ? ' active' : ''}" data-filter-key="${key}">${esc(picked ? picked[1] : f.label)}${CHEVRON}</button>`;
  }).join('');
  $('sortLabel').textContent = (LIB_SORTS.find((s) => s.key === view.sort) || LIB_SORTS[0]).label;
}

// 고르는 창 열기: kind 가 'sort' 면 정렬, 아니면 필터 이름
function openPickSheet(kind) {
  const isSort = kind === 'sort';
  const current = isSort ? view.sort : view[kind];
  const options = isSort ? LIB_SORTS.map((s) => [s.key, s.label]) : [['all', '전체'], ...LIB_FILTERS[kind].options()];
  $('pickTitle').textContent = isSort ? '정렬' : LIB_FILTERS[kind].label;
  $('pickList').innerHTML = options.map(([v, label]) => `
    <button type="button" class="pick-option${v === current ? ' active' : ''}" data-pick-kind="${kind}" data-pick-value="${esc(v)}">
      ${v === current ? CHECK : '<span class="check"></span>'}<span>${esc(label)}</span>
    </button>`).join('');
  $('pickSheet').showModal();
}

// 표지 (사진이 없거나 못 불러오면 제목 글자로 대신)
function coverHTML(w, cls) {
  return `
    <div class="${cls}">
      <span class="cover-fallback">${esc(w.title)}</span>
      ${w.cover ? `<img src="${esc(w.cover)}" alt="" loading="lazy" onerror="coverError(this)"${altsAttr(w)}>` : ''}
    </div>`;
}
const altsAttr = (w) => (w.coverAlts?.length ? ` data-alts="${esc(w.coverAlts.join(' '))}"` : '');

// 카드형: 한 줄에 표지 3개, 표지 왼쪽 위에 종류·플랫폼, 아래에 별점·제목·작가·상태·진행
function cardHTML(w) {
  return `
    <article class="card tile" data-id="${esc(w.id)}">
      <div class="cover">
        <span class="cover-fallback">${esc(w.title)}</span>
        ${w.cover ? `<img src="${esc(w.cover)}" alt="" loading="lazy" onerror="coverError(this)"${altsAttr(w)}>` : ''}
        ${badgesHTML(w)}
      </div>
      <div class="tile-info">
        <span class="stars small">${starsHTML(w.rating)}</span>
        <h3>${esc(w.title)}</h3>
        ${w.author ? `<p class="author">${esc(uniqueAuthors(w.author))}</p>` : ''}
        <div class="status-line">${statusHTML(w)}</div>
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
  { match: /네이버|naver/i, label: '네이버', letter: 'N', cls: 'naver' },
  { match: /카카오|kakao/i, label: '카카오', letter: 'K', cls: 'kakao' },
  { match: /리디|ridi/i, label: '리디', letter: 'R', cls: 'ridi' },
  { match: /레진|lezhin/i, label: '레진', letter: 'L', cls: 'lezhin' },
  { match: /미스터블루|mrblue/i, label: '미스터블루', letter: 'M', cls: 'mrblue' },
];

// 플랫폼은 색 + 첫 글자 작은 네모로, 3곳까지 (종류 배지와 합쳐 4개가 좁은 폰에서도 한 줄에 들어가게)
// 같은 회사는 하나로: 네이버웹툰 + 네이버 시리즈 → 네이버
function platformBadge(platform) {
  const brands = [];
  for (const name of String(platform || '').split(',')) {
    const found = PLATFORM_BADGES.find((p) => p.match.test(name));
    if (found && !brands.includes(found)) brands.push(found);
  }
  return brands.slice(0, 3)
    .map((b) => `<span class="badge badge-pf pf-${b.cls}" title="${b.label}" aria-label="${b.label}">${b.letter}</span>`).join('');
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
          ${statusHTML(w)}
        </div>
        ${w.review ? `<p class="review">${esc(w.review)}</p>` : ''}
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
// 상태 + 오른쪽에 본 회차 (예: "보는 중 34화", 최신 화수를 알면 "34 / 120화") - 서재 카드형·리스트형
function statusHTML(w) {
  const unit = unitOf(w.type, w.unit);
  const seen = w.progress || 0;
  const showProgress = seen || w.latest || w.status === 'reading';
  return `<span class="status status-${w.status}">${STATUSES[w.status]}</span>`
    + (showProgress ? `<span class="progress-text">${seen}${w.latest ? ` / ${w.latest}` : ''}${unit}</span>` : '');
}

// 홈 "내 서재": 기록한 작품을 책등처럼 쌓아서 (맨 위가 가장 최근, 너무 길어지지 않게 30권까지)
const SHELF_MAX = 30;
function renderHome() {
  const byUpdated = [...works].sort((a, b) => b.updatedAt - a.updatedAt);
  $('shelfCount').textContent = works.length || '';
  setHTMLKeepImages($('recentList'), works.length
    ? `<div class="stack">${byUpdated.slice(0, SHELF_MAX).map(spineHTML).join('')}</div>`
    : '<p class="hint">아직 기록한 작품이 없어요.<br>위 검색창에서 첫 작품을 추가해 보세요!</p>');
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
  setHTMLKeepImages($('feedList'), posts.length
    ? posts.map(feedHTML).join('')
    : '<p class="hint">작품에 한줄평을 남기면 여기에 쌓여요.</p>');
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
            ${first.cover ? `<img src="${esc(first.cover)}" alt="${esc(first.title)}" loading="lazy" onerror="coverError(this)"${altsAttr(first)}>` : ''}
            ${list.length > 1 ? `<span class="cal-more">+${list.length - 1}</span>` : ''}
          </span>` : ''}
      </button>`;
  }
  setHTMLKeepImages($('calGrid'), html);
  $('calSummary').innerHTML = monthCount
    ? `이번 달에 <b>${monthCount}작품</b>을 기록했어요`
    : '이번 달에 기록한 작품이 없어요';

  renderCalDayList();
}

// 선택한 날짜의 작품 목록 (날짜를 누를 때는 달력은 그대로 두고 이것만 다시 그림 - 달력 표지를 다시 불러오지 않게)
function renderCalDayList() {
  const { year, month } = cal;
  const picked = cal.selected && cal.selected.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)
    ? works.filter((w) => dateKey(w.createdAt) === cal.selected).sort((a, b) => a.createdAt - b.createdAt)
    : [];
  if (picked.length) {
    const [, m, d] = cal.selected.split('-').map(Number);
    setHTMLKeepImages($('calDayList'), `
      <h3 class="cal-day-title">${m}월 ${d}일에 추가한 작품 ${picked.length}개</h3>
      <div class="list">${picked.map(rowHTML).join('')}</div>`);
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
      cover: img && !/19over/.test(img.getAttribute('src')) ? img.getAttribute('src').replace(/\?type=.*$/, '?type=m480') : '', // m260 은 가로 173px 라 흐림
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
      loginOnly: !!data.loginOnly, // 19세 작품은 네이버 로그인이 있어야 열림
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
  // 레진코믹스: 검색 결과를 한 번에 다 줌 (페이지 없음, 만화/소설 묶음으로 옴)
  // 표지는 결과에 없어서 작품 번호로 만듦 (세로 표지 tall.webp 를 작게)
  // TODO: 나중에 성인 인증을 넣으면 19세(adult) 작품 표지는 인증한 사람에게만 보여주기
  lezhin: {
    platform: '레진코믹스',
    parse: (data) => (data.data?.sections || []).flatMap((sec) => (sec.items || []).map((c) => {
      const novel = sec.type === 'novel';
      return {
        sourceId: c.alias,
        title: c.title,
        author: (c.authors || []).map((a) => a.name).join(', '),
        cover: !novel && c.id ? `https://ccdn.lezhin.com/v2/comics/${c.id}/images/tall.webp?updated=${c.updatedAt || ''}&width=480` : '',
        type: novel ? 'webnovel' : c.book ? 'comic' : 'webtoon',
        url: `https://www.lezhin.com/ko/${novel ? 'novel' : 'comic'}/${encodeURIComponent(c.alias)}`,
        note: '',
        ongoing: '',
        adult: !!c.adult,
      };
    })),
    hasMore: () => false,
  },
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
      // 19세 작품은 미스터블루 로그인이 있어야 작품 페이지가 열려서 소개를 못 받음
      return {
        desc: data.desc || '',
        tags: data.tags || [],
        genre: data.genre || '',
        ongoing: /완결/.test(data.ongoing || '') ? '완결' : /연재/.test(data.ongoing || '') ? '연재중' : '',
        loginOnly: !!data.loginOnly,
      };
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
const ALL_SOURCES = ['naverWebtoon', 'kakaoWebtoon', 'kakao', 'seriesNovel', 'seriesComic', 'mrblue', 'lezhin', 'naverBest', 'naverChallenge'];
const sourceRank = (source) => ALL_SOURCES.indexOf(source);
// 제목 검색·다른 플랫폼 찾기에 쓰는 곳: 네이버 베스트도전·도전만화는 뺌 (정식 연재가 아니라서)
// (예전에 담은 베스트도전·도전만화 작품은 그대로 열리고 작품 정보도 받음)
const SEARCH_TARGETS = ALL_SOURCES.filter((s) => s !== 'naverChallenge' && s !== 'naverBest');


// 같은 작품인지 비교하려고 제목에서 띄어쓰기·기호·[독점] 같은 표시를 뺌
function titleKey(title) {
  return String(title || '').toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/[^0-9a-z가-힣ぁ-んァ-ヶ一-龥]/g, '');
}

// 지금 보고 있는 검색
// groups: 묶은 작품들 (key → { key, items: 플랫폼별 결과, order: 처음 나온 순서 })
// pages: 플랫폼별로 몇 페이지까지 봤는지 / 더 있는지 (더 보기 할 때 사용)
let searchState = { q: '', groups: new Map(), pages: {}, failed: [], loading: false, filter: { type: 'all', platform: 'all', ongoing: 'all' } };
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
// 한 번 고른 표지는 다른 플랫폼이 나중에 붙어도 바꾸지 않음 (목록 표지가 바뀌어 깜빡이지 않게)
// (카카오웹툰 캐릭터 그림밖에 없었을 때만 다른 플랫폼 표지로 바꿈)
const coverFailed = (i) => failedCovers.has(i.cover) || failedCovers.has(bigCover(i.cover));
function coverItem(group) {
  const prev = group.coverPick;
  if (prev && prev.source !== 'kakaoWebtoon' && group.items.includes(prev) && !coverFailed(prev)) return prev;
  const withCover = [...group.items].filter((i) => i.cover && !coverFailed(i))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0) || sourceRank(a.source) - sourceRank(b.source));
  group.coverPick = withCover.find((i) => i.source !== 'kakaoWebtoon') || withCover[0] || null;
  return group.coverPick;
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
      .filter(([source, p]) => p.hasMore && wantPlatform(source))
      .map(([source, p]) => ({ source, page: p.page + 1 }));
    const btn = $('s-more');
    if (btn && !btn.dataset.auto) { btn.disabled = true; btn.textContent = '불러오는 중…'; }
  } else if (fromFinder) {
    targets = searchState.finder.sources.map((source) => ({ source, page: 0 }));
    box.innerHTML = `<p class="msg">${esc(searchState.finder.genre.name)} 작품을 찾는 중…</p>`;
  } else {
    const q = $('s-query').value.trim();
    if (!q) return;
    searchState = { q, groups: new Map(), pages: {}, failed: [], loading: false, filter: { type: 'all', platform: 'all', ongoing: 'all' } };
    targets = SEARCH_TARGETS.map((source) => ({ source, page: 0 }));
    box.innerHTML = '<p class="msg">모든 플랫폼에서 찾는 중…</p>';
  }

  searchState.loading = true;
  searchState.failed = [];
  const { q, finder } = searchState;
  const shownBefore = more ? [...searchState.groups.values()].filter(passesFilters).length : 0;
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
  // 이미 받은 작품 (플랫폼:작품 번호) - 다음 페이지에 새 작품이 하나도 없으면 그 플랫폼은 끝으로 봄
  // (네이버 시리즈 장르 목록은 마지막 페이지를 넘어가도 마지막 페이지를 계속 다시 줌)
  const seen = new Set([...searchState.groups.values()].flatMap((g) => g.items.map((i) => `${i.source}:${i.sourceId}`)));
  results.forEach((res, i) => {
    const { source, page } = targets[i];
    if (res.status === 'fulfilled') {
      const fresh = res.value.items.some((it) => !seen.has(`${source}:${it.sourceId}`));
      addToGroups(source, res.value.items);
      searchState.pages[source] = { page, hasMore: res.value.hasMore && fresh };
    } else {
      searchState.failed.push(SEARCH_SOURCES[source].platform);
      // 더 보기에서 실패하면 다음에 같은 페이지를 다시 시도
      if (searchState.pages[source]) searchState.pages[source].hasMore = true;
    }
  });
  searchState.loading = false;
  // 이어서 불러오기가 모두 실패하면 저절로 다시 부르지 않음 (다시 불러오기 버튼)
  searchState.moreFailed = more && results.length > 0 && results.every((r) => r.status === 'rejected');
  // 이어서 불러왔는데 화면에 보이는 작품이 하나도 안 늘었으면(필터 때문에) 저절로 계속 부르지 않고 버튼으로
  searchState.moreIdle = more && !searchState.moreFailed
    && [...searchState.groups.values()].filter(passesFilters).length === shownBefore;
  renderSearchResults();
}

function renderSearchResults() {
  const box = $('s-results');
  const { finder } = searchState;
  const qKey = titleKey(searchState.q);
  // 인기순: 플랫폼을 골랐으면 그 플랫폼 순위로 (순위가 없는 작품 - 다른 플랫폼 찾기로 붙은 것 - 은 뒤로)
  const pickedPlatforms = searchState.filter.platform !== 'all' ? [searchState.filter.platform]
    : finder?.platforms?.size ? [...finder.platforms] : null;
  const rankItems = (g) => (pickedPlatforms
    ? g.items.filter((i) => pickedPlatforms.some((p) => inFilterPlatform(SEARCH_SOURCES[i.source].platform, p)))
    : g.items);
  // (플랫폼을 골랐을 때는 그 플랫폼 목록에서 받은 순위만 - 원작·웹툰판 카드에 붙인 소수 순위는 빼고)
  const bestRank = (g) => Math.min(9999, ...rankItems(g).map((i) => (pickedPlatforms
    ? (Number.isInteger(i.rank) ? i.rank : 9999)
    : i.rank ?? 9999)));
  // 순서: 제목이 검색어와 똑같은 작품 → 여러 플랫폼에 있는 작품 → 대표 플랫폼 순서 → 처음 나온 순서
  // (작품 찾기는 플랫폼 목록 순서를 섞어서: 각 플랫폼 1번째끼리 → 2번째끼리 …)
  // 작품 찾기 보는 순서: 인기순(기본) / 플랫폼 많은 순 / 제목순
  const sort = searchState.sort || 'rank';
  const byRank = (a, b) => bestRank(a) - bestRank(b) || sourceRank(mainItem(a).source) - sourceRank(mainItem(b).source);
  let all = [...searchState.groups.values()].sort(finder
    ? (sort === 'title' ? (a, b) => mainItem(a).title.localeCompare(mainItem(b).title, 'ko')
      : sort === 'platforms' ? (a, b) => groupPlatforms(b).length - groupPlatforms(a).length || byRank(a, b)
      : byRank)
    : (a, b) =>
      (titleKey(mainItem(b).title) === qKey) - (titleKey(mainItem(a).title) === qKey) ||
      b.items.length - a.items.length ||
      sourceRank(mainItem(a).source) - sourceRank(mainItem(b).source) ||
      a.order - b.order
  );
  // 작품 찾기에서 고른 종류 / 플랫폼(그 플랫폼이 들어 있으면 다른 플랫폼에도 있어도 됨)으로 거름
  if (finder) {
    all = all.filter((g) =>
      (!finder.types.size || finder.types.has(mainItem(g).type)) &&
      (!finder.platforms?.size || g.items.some((i) => [...finder.platforms].some((p) => inFilterPlatform(SEARCH_SOURCES[i.source].platform, p)))));
  }
  const failed = searchState.failed.length
    ? `<p class="msg"><small>${finder ? '불러오지 못한 곳' : '검색하지 못한 곳'}: ${esc(searchState.failed.join(', '))}</small></p>`
    : '';
  if (!all.length) {
    box.innerHTML = (searchState.failed.length === (finder ? finder.sources.length : SEARCH_TARGETS.length)
      ? '<p class="msg">검색에 실패했어요. 잠시 후 다시 해보세요.</p>'
      : '<p class="msg">검색 결과가 없어요.</p>') + failed;
    return;
  }

  // 종류 · 연재 상태 / 플랫폼 필터 (종류·플랫폼은 결과에 있는 것만 버튼으로)
  // 연재 상태: 연재중 / 완결 (다시 누르면 해제, 연재 상태를 모르는 작품은 고르면 빠짐)
  const f = searchState.filter;
  const platformOf = (i) => SEARCH_SOURCES[i.source].platform;
  const typesIn = Object.keys(TYPES).filter((t) => all.some((g) => mainItem(g).type === t));
  // 작품 찾기는 다른 플랫폼을 나중에 찾아 붙이니까 처음부터 모든 플랫폼 버튼을 보여줌
  // (버튼은 네이버웹툰·네이버 시리즈를 "네이버" 하나로 - filterPlatformOf)
  const platformsIn = [...new Set(SEARCH_TARGETS.map((s) => filterPlatformOf(SEARCH_SOURCES[s].platform)))]
    .filter((p) => finder || all.some((g) => g.items.some((i) => inFilterPlatform(platformOf(i), p))))
    .sort((a, b) => (FILTER_ORDER.indexOf(a) + 1 || 99) - (FILTER_ORDER.indexOf(b) + 1 || 99));
  const chip = (kind, value, label) =>
    `<button type="button" class="f-chip${f[kind] === value ? ' active' : ''}" data-filter="${kind}" data-value="${esc(value)}">${esc(label)}</button>`;
  const filters = `
    <div class="s-filters">
      <div class="f-row">${chip('type', 'all', '전체')}${typesIn.map((t) => chip('type', t, TYPES[t])).join('')}<span class="f-sep"></span>${chip('ongoing', '연재중', '연재중')}${chip('ongoing', '완결', '완결')}</div>
      <div class="f-row">${chip('platform', 'all', '모든 플랫폼')}${platformsIn.map((p) => chip('platform', p, p)).join('')}</div>
    </div>`;
  const ongoingOf = (g) => mergeOngoing(g.items.map((i) => i.ongoing));
  const groups = all.filter((g) =>
    (f.type === 'all' || mainItem(g).type === f.type) &&
    (f.platform === 'all' || g.items.some((i) => inFilterPlatform(platformOf(i), f.platform))) &&
    (f.ongoing === 'all' || (f.ongoing === '완결' ? /완결/.test(ongoingOf(g)) : ongoingOf(g) === f.ongoing)));

  // 플랫폼 필터를 골랐으면 그 플랫폼에 다음 페이지가 있을 때만 더 불러옴
  const hasMore = Object.entries(searchState.pages).some(([source, p]) => p.hasMore && wantPlatform(source));
  const countLabel = finder ? `${finder.genre.name} 인기 작품` : '검색 결과';
  // 제목 검색은 리스트(한 줄에 하나), 장르별 검색·작품 찾기는 카드(한 줄에 표지 3개)
  const itemHTML = finder ? searchCardHTML : searchRowHTML;
  const list = groups.map(itemHTML).join('');
  // 다시 그려도 이미 화면에 있던 표지 그림은 그대로 옮겨 씀 (표지가 깜빡이지 않게)
  const sortHTML = finder ? `
    <select class="s-sort" aria-label="보는 순서">
      ${Object.entries(FINDER_SORTS).map(([v, label]) => `<option value="${v}"${v === sort ? ' selected' : ''}>${label}</option>`).join('')}
    </select>` : '';
  setHTMLKeepImages(box, filters + `<div class="s-count-row"><p class="s-count">${esc(countLabel)} ${groups.length}${hasMore ? '+' : ''}</p>${sortHTML}</div>`
    + (groups.length ? '' : '<p class="msg no-match">조건에 맞는 작품이 없어요.</p>')
    + (finder ? `<div class="s-grid">${list}</div>` : list) + failed
    // 작품 찾기에서 플랫폼을 골랐으면 아직 다른 플랫폼을 안 찾아본 작품도 찾는 중이라고 표시
    + (finder && f.platform !== 'all' && all.some((g) => !g.done)
      ? '<p id="lookingNote" class="msg"><span class="spinner small"></span> 다른 플랫폼에서도 찾는 중…</p>' : '')
    + (!hasMore
    ? `<p class="msg">${finder ? '작품을 모두 봤어요.' : '검색 결과를 모두 봤어요.'}</p>`
    : searchState.moreFailed || searchState.moreIdle
      // 이어서 불러오기가 실패했거나 보이는 작품이 안 늘었으면 저절로 다시 부르지 않고 버튼으로
      ? `<button type="button" id="s-more" class="ghost s-more">${searchState.moreFailed ? '다시 불러오기' : '더 불러오기'}</button>`
      : `<p id="s-more" class="msg s-more-auto" data-auto="1"><span class="spinner small"></span></p>`));
  watchMore();
  watchCards();
}

// 검색 결과 한 작품의 표지 (카카오웹툰 캐릭터 그림은 작품 배경색을 깔아 줌)
function searchCoverHTML(g, big = false) {
  const cover = coverItem(g);
  const bg = /^#[0-9a-f]{3,8}$/i.test(cover?.coverBg || '') ? ` style="background:${cover.coverBg}"` : '';
  const src = big ? bigCover(cover?.cover) : cover?.cover;
  const alts = coverAlts(g, cover, big);
  // 표지가 없으면 src 를 빼서 깨진 그림 표시 대신 빈 칸으로
  return `<img${src ? ` src="${esc(src)}" onerror="coverError(this)"${alts.length ? ` data-alts="${esc(alts.join(' '))}"` : ''}` : ''} alt="" loading="lazy"${bg}>`;
}

// 고른 표지를 못 불러오면 대신 쓸 같은 작품의 다른 플랫폼 표지들
function coverAlts(g, cover, big = false) {
  return [...new Set(g.items.filter((i) => i !== cover && i.cover).map((i) => (big ? bigCover(i.cover) : i.cover)))]
    .filter((u) => u && !/\s/.test(u));
}

// 크게 보이는 곳(카드·작품 정보·서재)에 쓸 큰 표지 주소
// 카카오페이지 목록 그림(th3)은 가로 240px 라 카드에서 흐려서 원본(o1, 720px)으로 - 작은 목록 표지는 그대로 th3
const bigCover = (url) => String(url || '').replace(/(page-images\.kakaoentcdn\.com\/download\/resource\?kid=[^&]+&filename=)th\d/, '$1o1');
const groupPlatforms = (g) => [...new Set(g.items.map((i) => SEARCH_SOURCES[i.source].platform))];

// 리스트형 (제목 검색): 왼쪽 표지 + 오른쪽 제목·작가·종류·연재 상태·플랫폼
function searchRowHTML(g) {
  const main = mainItem(g);
  return `
    <button type="button" class="s-item" data-key="${esc(g.key)}">
      ${searchCoverHTML(g)}
      <span class="s-body">
        <b>${esc(main.title)}</b>
        <small>${esc([main.author, TYPES[main.type], g.items.find((i) => i.ongoing)?.ongoing].filter(Boolean).join(' · '))}</small>
        <span class="pf-icons">${groupPlatforms(g).map((p) => pfIconHTML(p)).join('')}</span>
      </span>
      ${findInLibrary(g) ? '<span class="in-library">내 서재</span>' : ''}
    </button>`;
}

// 카드형 (장르별 검색·작품 찾기): 표지 + 제목 두 줄 + 작가 + 플랫폼
function searchCardHTML(g) {
  const main = mainItem(g);
  return `
    <button type="button" class="s-item s-card" data-key="${esc(g.key)}">
      <span class="s-card-cover">
        ${searchCoverHTML(g, true)}
        ${searchBadgesHTML(g)}
        ${findInLibrary(g) ? '<span class="in-library">내 서재</span>' : ''}
      </span>
      <b>${esc(main.title)}</b>
      <small>${esc(main.author || '')}</small>
    </button>`;
}

// 카드 표지 왼쪽 위: 종류 + 플랫폼 (서재 카드와 같은 모양, 검색은 어느 플랫폼인지가 중요해서 회사로 묶지 않고 플랫폼마다)
function searchBadgesHTML(g) {
  const pf = (name) => {
    const icon = PLATFORM_ICONS.find((p) => p.match.test(name));
    return `<span class="badge badge-pf pf-${icon?.cls || 'etc'}" title="${esc(name)}" aria-label="${esc(name)}">${icon?.letter || esc(name[0])}</span>`;
  };
  return `<span class="badges"><span class="badge">${esc(TYPES[mainItem(g).type] || '')}</span>${groupPlatforms(g).map(pf).join('')}</span>`;
}

// 끝까지 스크롤하면 저절로 다음 페이지 (맨 아래 표시가 화면 근처에 오면 불러옴)
let moreObserver = null;
function watchMore() {
  if (!('IntersectionObserver' in window)) return;
  moreObserver ||= new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !searchState.loading) searchPlatform(true);
  }, { root: $('searchPage'), rootMargin: '0px 0px 600px 0px' });
  moreObserver.disconnect();
  const sentinel = $('s-more');
  if (sentinel?.dataset.auto) moreObserver.observe(sentinel);
}


// ----- 6-2-1. 작품 찾기 (홈 배너 "뭐 볼지 고민될 때") -----
// 장르를 고르면 플랫폼마다 장르별 인기 목록을 받아서 검색 결과 화면에 보여줌
// 순서: 네이버웹툰 인기순 · 카카오웹툰 장르 랭킹 · 카카오페이지 장르 일간 랭킹 · 네이버 시리즈 판매순 · 미스터블루 인기순
//      (네이버웹툰 태그 목록만 순서를 고를 수 없어서 네이버가 주는 순서)
// 플랫폼마다 장르를 부르는 방법이 달라서 장르마다 적어 둠
//   naver: 네이버웹툰 장르 코드 / naverTag: 네이버웹툰 태그 번호 (장르에 없는 로판·현판·학원물)
//   kw: 카카오웹툰 장르 랭킹 이름 (rank_ 뒤)
//   kpToon·kpNovel: 카카오페이지 웹툰·웹소설 세부 장르 번호
//   novel·comic: 네이버 시리즈 웹소설·만화 장르 코드 (만화 90 '소년'은 소년 장르로 씀)
//   mbToon·mbComic·mbNovel: 미스터블루 웹툰·만화·소설 장르 페이지 주소 (여러 개면 합침)
//   lz: 레진코믹스 장르 (레진은 장르별 목록이 없어서 전체 인기 순위 500개를 받아 장르로 거름)
//     미스터블루 소설 '판타지' 전체에는 현대판타지가 대부분이라, 판타지는 현판을 뺀 세부 장르만 / 로맨스도 로판을 뺀 세부 장르만
const MB_COMIC = (genre, id) => `comic/list?genre=${genre}&genreIds=${id}`;
const FINDER_GENRES = [
  { name: '순정·로맨스', lz: ['romance'], naver: ['PURE'], kw: 'romance', kpToon: '121', kpNovel: '89', novel: '201', comic: '99',
    mbToon: 'webtoon/genre/romance', mbComic: MB_COMIC('ROMANCE', '01'),
    mbNovel: ['novel/genre/romance/modern', 'novel/genre/romance/history'] },
  { name: '로판', naverTag: '51', kw: 'romance_fantasy', kpToon: '69', kpNovel: '117', novel: '207',
    mbNovel: 'novel/genre/romance/romancefantasy' },
  { name: '판타지', lz: ['fantasy'], naver: ['FANTASY'], kw: 'fantasy_drama', kpToon: '115', kpNovel: '86', novel: '202',
    mbToon: 'webtoon/genre/fantasy', mbComic: MB_COMIC('ACTION-FANTASY', '05'),
    mbNovel: ['novel/genre/fantasy/fusionfantasy', 'novel/genre/fantasy/originfantasy', 'novel/genre/fantasy/war'] },
  { name: '현판', naverTag: '379', kpNovel: '120', novel: '208', mbNovel: 'novel/genre/fantasy/modernfantasy' },
  { name: '무협', naver: ['HISTORICAL'], kw: 'action_wuxia', kpToon: '112', kpNovel: '87', novel: '206', comic: '88',
    mbComic: MB_COMIC('HEROISM', '04'), mbNovel: 'novel/genre/heroism/' },
  { name: '액션', lz: ['action'], naver: ['ACTION'], kw: 'action_wuxia', kpToon: '122',
    mbToon: 'webtoon/genre/action', mbComic: MB_COMIC('ACTION-FANTASY', '24') },
  { name: '드라마', lz: ['drama'], naver: ['DRAMA'], kw: 'drama', kpToon: '116', comic: '93',
    mbToon: 'webtoon/genre/drama', mbComic: MB_COMIC('ACTION-FANTASY', '07') },
  // 공포는 네이버 스릴러 장르·카카오웹툰 공포/스릴러 랭킹에 같이 들어 있음 + 네이버 '공포' 태그
  { name: '공포·스릴러', lz: ['mystery'], naver: ['THRILL'], naverTag: [236], kw: 'horror_thriller', novel: '203',
    mbToon: 'webtoon/genre/thriller', mbNovel: 'novel/genre/others/mysterythriller' },
  // 소년: 네이버 소년물·소년왕도물 태그, 네이버 시리즈 만화 '소년', 미스터블루 웹툰 키워드 '소년'
  // (웹소설도 들어갈 수 있게 '소년만화'가 아니라 '소년' - 지금은 소년 웹소설 목록을 주는 플랫폼이 없음)
  { name: '소년', naverTag: [334, 66], comic: '90', mbToon: 'keywords/webtoon?id=870' },
  // 학원·스포츠는 다른 장르와 겹쳐도 됨 (현판이면서 학원물이면 두 장르에 다 나옴)
  // 학원: 네이버 학원물·아카데미물 태그, 카카오웹툰 캠퍼스물·학원로맨스물, 미스터블루 학원/캠퍼스 키워드·만화 학원
  { name: '학원', lz: ['school'], kp: ['학원물', '캠퍼스물', '학원'], naverTag: [95, 262], kwKey: ['캠퍼스물', '학원로맨스물'], mbNovel: 'keywords/novel?id=12',
    mbToon: 'keywords/webtoon?id=879', mbComic: MB_COMIC('ACTION-FANTASY', '02') },
  { name: '스포츠', kp: ['스포츠', '스포츠물'], naver: ['SPORTS'], naverTag: [67], mbNovel: 'keywords/novel?id=28',
    mbToon: 'keywords/webtoon?id=872', mbComic: MB_COMIC('ACTION-FANTASY', '09') },
  // 미스터블루는 개그·일상 장르 페이지가 없어서 키워드 페이지(웹툰 개그/코믹·일상, 소설 개그물)로
  { name: '일상·개그', lz: ['gag', 'day'], naver: ['DAILY', 'COMIC'], kw: 'comic_everyday_life',
    mbToon: ['keywords/webtoon?id=866', 'keywords/webtoon?id=876'], mbNovel: 'keywords/novel?id=125' },
  { name: '라노벨', novel: '205', mbNovel: 'novel/genre/fantasy/lightnovel' },
  { name: 'BL', lz: ['bl'], kwKey: ['BL'], kpToon: '119', kpNovel: '123', novel: '209', comic: '107',
    mbToon: 'webtoon/genre/bl', mbComic: MB_COMIC('BL', '22'), mbNovel: 'novel/genre/bl/' },
];
const FINDER_PLATFORMS = ['네이버', '카카오페이지', '카카오웹툰', '미스터블루', '레진코믹스'];
const FINDER_SORTS = { rank: '인기순', platforms: '플랫폼 많은 순', title: '제목순' };
// 플랫폼 고르는 버튼 순서
const FILTER_ORDER = ['네이버', '카카오페이지', '카카오웹툰', '미스터블루', '레진코믹스'];

// 플랫폼 고르는 버튼에서만 네이버웹툰 + 네이버 시리즈를 "네이버" 하나로 묶음 (카드 배지는 플랫폼마다 따로)
const FILTER_GROUPS = { 네이버: ['네이버웹툰', '네이버 시리즈'] };
const filterPlatformOf = (platform) => Object.keys(FILTER_GROUPS).find((k) => FILTER_GROUPS[k].includes(platform)) || platform;
const inFilterPlatform = (platform, picked) => platform === picked || !!FILTER_GROUPS[picked]?.includes(platform);

// 키워드 (장르 대신 고름): 플랫폼마다 다른 태그·키워드를 우리 이름 하나로 묶음
// 키워드 목록이 있는 곳만 - 네이버웹툰 태그 · 카카오웹툰 키워드 · 미스터블루 키워드
// (네이버 시리즈는 키워드별 목록이 없어서 빠짐)
//   naverTag: 네이버웹툰 태그 번호 / kwKey: 카카오웹툰 키워드 이름 / mbNovel·mbToon: 미스터블루 키워드 페이지
//   kp: 카카오페이지 키워드 필터 이름 (카카오페이지는 키워드가 잘게 나뉘어 있어서 비슷한 것 여러 개, 인기순)
//   (모두 여러 개면 합침) / hot: 검색 화면 "키워드 검색"에 보여줄 것
// 번호·이름은 2026-10-15 각 플랫폼에서 확인: 네이버 인기 400개 작품의 태그, 카카오웹툰 키워드 검색 결과 수,
// 미스터블루 키워드 검색 페이지(mrblue.com/keywords/novel, /webtoon)
const MB_KEY = (type, id) => `keywords/${type}?id=${id}`;
// (웹툰 키워드 페이지에 웹툰과 만화가 같이 나와서 만화 페이지는 따로 받지 않음)
const mb = (novelIds, toonIds) => ({
  ...(novelIds && { mbNovel: [].concat(novelIds).map((id) => MB_KEY('novel', id)) }),
  ...(toonIds && { mbToon: [].concat(toonIds).map((id) => MB_KEY('webtoon', id)) }),
});
const KEYWORD_GROUPS = [
  { name: '세계관', icon: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>', keywords: [
    { name: '이세계', kp: ['차원이동'], naverTag: [78], ...mb(null, 894), hot: true },
    { name: '현대', kp: ['현대물'], naverTag: [349], ...mb(14, 900) },
    { name: '동양풍/사극', kwKey: ['가상시대물'], kp: ['동양풍', '퓨전사극'], naverTag: [348, 115, 91], ...mb(5, 884) },
    { name: '서양풍/중세', kp: ['서양풍', '중세물'], naverTag: [350, 354], ...mb(9, 887) },
    { name: '궁정/귀족', kp: ['왕족/귀족', '궁정로맨스'], naverTag: [314], ...mb([34, 4]) },
    { name: '오피스', kp: ['오피스물', '회사원'], naverTag: [345, 73], kwKey: ['오피스물'], ...mb(null, 892) },
    { name: '연예계', kp: ['연예계물', '아이돌물'], naverTag: [71, 220], ...mb(32, 891) },
    { name: '역사/시대물', kp: ['시대물', '대체역사'], naverTag: [347, 188], ...mb(10, 890) },
    { name: '아포칼립스', kp: ['아포칼립스'], naverTag: [122, 378, 419], kwKey: ['재난물'], hot: true },
    { name: 'SF/미래', kp: ['SF'], naverTag: [103, 352], ...mb(1) },
  ] },
  { name: '소재', icon: '<path d="M6 3h12v18l-6-4-6 4z"/>', keywords: [
    { name: '회귀', kp: ['회귀', '회귀물', '회귀/타임슬립', '타임슬립'], naverTag: [99, 187], kwKey: ['회귀물', '타임슬립'], ...mb(42, 902), hot: true },
    { name: '빙의', kp: ['빙의', '빙의물', '영혼체인지/빙의'], naverTag: [58], kwKey: ['빙의물'], ...mb(25, 934), hot: true },
    { name: '환생', kp: ['환생', '환생물', '전생/환생'], naverTag: [319], kwKey: ['환생물'], ...mb(38, 901), hot: true },
    { name: '차원이동', kp: ['차원이동', '차원이동물'], naverTag: [128], kwKey: ['차원이동물'], ...mb(40, 897) },
    { name: '헌터/레이드', kp: ['레이드', '헌터물'], naverTag: [96], hot: true },
    { name: '게임/상태창', kp: ['시스템', '게임', '플레이어'], naverTag: [344, 343, 112], kwKey: ['레벨업물'], ...mb(null, 908), hot: true },
    { name: '던전/탑', kp: ['탑등반'], naverTag: [242, 428] },
    { name: '초능력', kp: ['이능력', '초능력'], naverTag: [340, 77], ...mb(41, 950) },
    { name: '마법', kp: ['마법사'], naverTag: [336] },
    { name: '생존/데스게임', kp: ['생존', '서바이벌'], naverTag: [342, 186, 339] },
    { name: '복수', kp: ['복수', '복수물'], naverTag: [57], kwKey: ['복수물'], ...mb(24, 885), hot: true },
    { name: '성장', kp: ['성장물', '성장'], naverTag: [227, 65], kwKey: ['성장물', '성공성장물'], ...mb(130, 889), hot: true },
    { name: '육아', kp: ['육아물', '육아'], naverTag: [126], kwKey: ['육아물'], ...mb(136, 893), hot: true },
    { name: '요리', kp: ['요리사', '요리능력물'], naverTag: [74, 252], ...mb(null, 937) },
    { name: '범죄/조직', kp: ['조직/암흑가', '범죄'], naverTag: [205, 44], kwKey: ['범죄스릴러물', '조직/암흑가'], ...mb(39, 883) },
    { name: '전문직', kp: ['전문직', '전문직물', '메디컬물'], naverTag: [127, 76, 173], kwKey: ['전문직물'], ...mb([37, 20, 22]) },
    { name: '인외존재', kp: ['인외존재', '이종족'], naverTag: [79], ...mb(36, 939) },
    { name: '오컬트/괴담', kp: ['오컬트', '귀신', '크툴루'], naverTag: [124, 41, 376] },
    { name: '전쟁/군대', kp: ['전쟁', '전쟁물', '군대물'], naverTag: [332, 116], kwKey: ['전쟁물', '군대물'], ...mb(15, [941, 896]) },
    { name: '동물', naverTag: [47], ...mb(null, 919) },
  ] },
  { name: '관계', icon: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M15.5 14.5c3 0 5.5 2.2 5.5 5.5"/>', keywords: [
    { name: '첫사랑', kp: ['첫사랑'], naverTag: [321], ...mb(64, 949) },
    { name: '짝사랑', kp: ['짝사랑'], naverTag: [189], ...mb(63, 945) },
    { name: '친구>연인', kp: ['친구>연인', '소꿉친구'], naverTag: [88, 185], ...mb(65, 951) },
    { name: '계약/정략결혼', kp: ['계약관계', '정략결혼', '계약연애/결혼'], naverTag: [64, 114], ...mb([44, 62, 53], 964), hot: true },
    { name: '결혼생활', kp: ['결혼'], naverTag: [335, 249], ...mb(null, 968) },
    { name: '혐관/애증', kp: ['배틀연애'], naverTag: [320, 129], ...mb(null, 973) },
    { name: '라이벌', kp: ['라이벌/앙숙'], naverTag: [323], ...mb(47) },
    { name: '재회', kp: ['재회물'], naverTag: [81, 82], ...mb(61, 895) },
    { name: '사내연애', kp: ['사내연애'], naverTag: [59], ...mb(50) },
    { name: '삼각관계', kp: ['삼각관계'], naverTag: [62], ...mb(52, [966, 970]) },
    { name: '연상연하', kp: ['나이차커플', '연하남'], naverTag: [70], ...mb(46, [965, 974]) },
    { name: '신분차이', kp: ['신분차이'], ...mb(55) },
    { name: '사제지간', ...mb(51, 969) },
    { name: '키잡', ...mb([66, 57], 898) },
    { name: '하렘/역하렘', kp: ['하렘', '역하렘'], naverTag: [386, 69], kwKey: ['하렘물'], ...mb(31, 956) },
    { name: '집착', kp: ['소유욕/독점욕', '집착'], naverTag: [197], ...mb(54) },
    { name: '동거', kp: ['동거물'], kwKey: ['동거물'], ...mb(18, 918) },
    { name: '우정', naverTag: [325], ...mb(null, 935) },
    { name: '가족', kp: ['가족물'], naverTag: [324], kwKey: ['가족물'] },
  ] },
  { name: '캐릭터', icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>', keywords: [
    { name: '먼치킨', kp: ['먼치킨'], naverTag: [53], ...mb(null, 921), hot: true },
    { name: '힘숨찐', naverTag: [102] },
    { name: '악역 주인공', kp: ['악녀'], naverTag: [330, 231], ...mb(133) },
    { name: '걸크러시', kp: ['걸크러쉬'], naverTag: [37], ...mb(97) },
    { name: '능력있는', kp: ['능력녀', '능력남'], naverTag: [303, 271], ...mb([72, 103]) },
    { name: '재벌', kp: ['재벌남', '재벌녀'], naverTag: [202, 302, 291], ...mb([85, 115], 982) },
    { name: '다정한', kp: ['다정남', '다정녀'], naverTag: [199, 276], ...mb([73, 104], 979) },
    { name: '햇살캐', naverTag: [219, 307, 283] },
    { name: '순정파', kp: ['순정남', '순정녀'], naverTag: [298, 275, 409, 412], ...mb([79, 109]) },
    { name: '대형견', kp: ['대형견남'], naverTag: [301], ...mb(74) },
    { name: '집착하는', kp: ['집착남'], naverTag: [296, 390], ...mb([90, 118], [986, 992]) },
    { name: '후회하는', kp: ['후회남', '후회녀'], naverTag: [196], ...mb([96, 124], [989, 995]) },
    { name: '계략적인', kp: ['계략남', '계략녀'], naverTag: [297, 179], ...mb([67, 98], 976) },
    { name: '직진하는', kp: ['직진남', '직진녀'], naverTag: [85], ...mb([89, 117], [985, 991]) },
    { name: '나쁜남자', kp: ['나쁜남자'], naverTag: [294], ...mb(69) },
    { name: '까칠한', kp: ['까칠남'], naverTag: [43, 389], ...mb([68, 99], [977, 990]) },
    { name: '철벽', kp: ['철벽녀', '철벽남'], naverTag: [273], ...mb([92, 120], [987, 993]) },
    { name: '능글맞은', kp: ['능글남'], naverTag: [299], ...mb([71, 102], 978) },
    { name: '무심한', kp: ['무심녀'], naverTag: [305, 272], ...mb([76, 107], 980) },
    { name: '상처있는', kp: ['상처녀', '상처남'], naverTag: [308, 244], ...mb([78, 108], 1022) },
    { name: '평범한', kp: ['평범녀'], naverTag: [304, 279], ...mb([95, 123], [988, 994]) },
    { name: '미남/미녀', kp: ['미남', '미인'], naverTag: [313, 292] },
  ] },
  { name: '분위기', icon: '<path d="M12 3v2M5.6 7.6 7 9M18.4 7.6 17 9M3 14h2M19 14h2"/><path d="M8 14a4 4 0 0 1 8 0"/><path d="M4 18h16M8 21h8"/>', keywords: [
    { name: '힐링', kp: ['힐링물', '치유물'], naverTag: [130, 221], kwKey: ['힐링물', '따뜻한'], ...mb(141, 903), hot: true },
    { name: '설레는', kp: ['달달물', '두근거리는'], naverTag: [360, 203], kwKey: ['설레는'], ...mb(127) },
    { name: '로맨틱코미디', kp: ['로맨틱코미디'], naverTag: [385, 270, 176], kwKey: ['로맨틱코미디물'], ...mb(129) },
    { name: '사이다/통쾌한', kp: ['사이다녀', '권선징악'], naverTag: [119, 253], kwKey: ['통쾌한'], hot: true },
    { name: '잔잔한/감성', kp: ['잔잔물'], naver: ['SENSIBILITY'], naverTag: [364, 269], ...mb(137) },
    { name: '눈물샘', kp: ['애잔물'], naverTag: [357], kwKey: ['가슴 먹먹한', '슬픈'], ...mb([131, 134]) },
    { name: '피폐한', kp: ['피폐물'], naverTag: [359], kwKey: ['피폐물', '처절한'], ...mb(139, 899) },
    { name: '다크한', kwKey: ['우울한'], kp: ['시리어스물'], naverTag: [361, 45] },
    { name: '미스터리한', kp: ['미스테리', '추리물'], naverTag: [250, 63], kwKey: ['미스테리한'], ...mb(138) },
    { name: '긴장감 있는', kp: ['스릴 넘치는'], naverTag: [362, 375, 380], kwKey: ['긴장감 있는'] },
    { name: '열혈', kwKey: ['역동적인'], naverTag: [363] },
  ] },
];
const FINDER_KEYWORDS = KEYWORD_GROUPS.flatMap((g) => g.keywords);

// 고른 종류에 맞는 목록만 (types 가 비어 있으면 전체)
const wantType = (types, ...these) => !types.size || these.some((t) => types.has(t));

// 플랫폼별 장르 목록 받기 → { items, hasMore } (검색 결과와 같은 모양)
// 한 플랫폼에서 여러 목록(예: 웹툰 + 웹소설)을 받으면 합쳐서 돌려줌
// (키워드 하나에 태그 여러 개처럼 목록이 여럿이면 일부가 실패해도 받은 것만 보여줌, 모두 실패하면 실패)
async function mergeLists(jobs) {
  const results = await Promise.allSettled(jobs);
  const lists = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (results.length && !lists.length) throw results[0].reason;
  // 목록을 번갈아 섞음 (각 목록 1번째끼리 → 2번째끼리 …) - 인기순이 한 목록에 쏠리지 않게
  const items = [];
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.items.length)); i++) {
    for (const l of lists) if (l.items[i]) items.push(l.items[i]);
  }
  return { items, hasMore: lists.some((l) => l.hasMore) };
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
    ...[].concat(g.naverTag || []).map(async (tag) => {
      const d = await callServer('naverTag', String(tag), page);
      return { items: (d.curationViewList || []).map(naverListItem), hasMore: naverHasMore(d) };
    }),
  ]),
  // 카카오웹툰: 키워드는 키워드 검색 (검색 결과와 같은 모양) / 장르는 장르 랭킹 (100개, 다음 페이지 없음)
  kakaoWebtoon: async (g, page) => {
    if (g.kwKey) {
      return mergeLists([].concat(g.kwKey).map(async (key) => {
        const d = await callServer('kakaoWebtoonKeyword', key, page);
        return { items: SEARCH_SOURCES.kakaoWebtoon.parse(d), hasMore: SEARCH_SOURCES.kakaoWebtoon.hasMore(d) };
      }));
    }
    if (page > 0) return { items: [], hasMore: false };
    const d = await callServer('kakaoWebtoonRank', g.kw, 0);
    const ongoing = { EPISODES_PUBLISHING: '연재중', COMPLETED: '완결', END_OF_SEASON: '시즌 완결', SEASON_COMPLETED: '시즌 완결' };
    const items = (d.items || []).map((c) => ({
      sourceId: c.id,
      title: c.title,
      author: uniqueAuthors((c.authors || []).join(', ')),
      cover: c.image ? `${c.image}.png` : '',
      coverBg: c.bg || '',
      type: 'webtoon',
      url: c.seoId ? `https://webtoon.kakao.com/content/${encodeURIComponent(c.seoId)}/${c.id}` : '',
      note: '',
      ongoing: ongoing[c.status] || '',
    }));
    return { items, hasMore: false };
  },
  // 카카오페이지 장르 목록은 검색 결과와 모양이 같아서 검색 결과 읽는 법을 그대로 씀
  kakao: (g, page, types) => g.kp ? mergeLists(g.kp.map(async (name) => {
    // 키워드: 카카오페이지 키워드 필터 검색 (검색 결과와 같은 모양, 인기순 20개씩)
    const d = await callServer('kakaoFilter', name, page);
    const items = SEARCH_SOURCES.kakao.parse(d).filter((i) => wantType(types, i.type));
    items.forEach((i) => { i.author = uniqueAuthors(i.author); });
    return { items, hasMore: SEARCH_SOURCES.kakao.hasMore(d) };
  })) : mergeLists([
    g.kpToon && wantType(types, 'webtoon', 'comic') && `10/${g.kpToon}`,
    g.kpNovel && wantType(types, 'webnovel') && `11/${g.kpNovel}`,
  ].filter(Boolean).map(async (q) => {
    const d = await callServer('kakaoGenre', q, page);
    const items = SEARCH_SOURCES.kakao.parse(d);
    items.forEach((i) => { i.author = uniqueAuthors(i.author); });
    return { items, hasMore: SEARCH_SOURCES.kakao.hasMore(d) };
  })),
  // 레진코믹스: 전체 인기 순위(500개, 다음 페이지 없음)에서 고른 장르가 붙은 작품만
  lezhin: async (g, page) => {
    if (page > 0) return { items: [], hasMore: false };
    lezhinRank = lezhinRank || callServer('lezhinRank', 'all').catch((e) => { lezhinRank = null; throw e; });
    const d = await lezhinRank;
    const items = (d.items || []).filter((c) => (c.genres || []).some((x) => g.lz.includes(x))).map((c) => ({
      sourceId: c.alias,
      title: c.title,
      author: uniqueAuthors((c.authors || []).join(', ')),
      cover: c.id ? `https://ccdn.lezhin.com/v2/comics/${c.id}/images/tall.webp?updated=${c.updatedAt || ''}&width=480` : '',
      type: 'webtoon',
      url: `https://www.lezhin.com/ko/comic/${encodeURIComponent(c.alias)}`,
      note: '',
      ongoing: c.state === 'completed' ? '완결' : c.state === 'scheduled' ? '연재중' : '',
    }));
    return { items, hasMore: false };
  },
  seriesNovel: (g, page) => seriesGenreList('novel', g.novel, page),
  seriesComic: (g, page) => seriesGenreList('comic', g.comic, page),
  // 미스터블루 장르 페이지 인기순: 한 번에 100~120개 (다음 페이지는 만화 목록만 있음)
  // 키워드 페이지는 검색 결과와 모양이 같아서 검색 결과 읽는 법으로 (종류·완결 표시도 거기서 읽힘)
  mrblue: (g, page, types) => {
    const list = (paths) => [].concat(paths || []);
    const isKeyword = (p) => p.startsWith('keywords/');
    const jobs = [
      ...list(g.mbToon).filter((p) => wantType(types, 'webtoon', ...(isKeyword(p) ? ['comic'] : []))).map((p) => [p, 'webtoon']),
      ...(wantType(types, 'comic') ? list(g.mbComic).map((p) => [p, 'comic']) : []),
      ...(wantType(types, 'webnovel') ? list(g.mbNovel).map((p) => [p, 'webnovel']) : []),
    ].filter(([path]) => page === 0 || path.startsWith('comic/'));
    return mergeLists(jobs.map(async ([path, type]) => {
      const html = await callServer('mrblueGenre', path, page, true);
      const items = isKeyword(path) ? parseMrblue(html) : parseMrblueGenre(html, type);
      items.forEach((i) => { i.author = uniqueAuthors(i.author); });
      return { items, hasMore: path.startsWith('comic/') && items.length >= 120 };
    }));
  },
};

// 레진 인기 순위는 앱을 켜 둔 동안 한 번만 받아서 장르마다 나눠 씀
let lezhinRank = null;

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
      // 웹툰 목록에만 '완결'·'휴재' 표시가 있음 (표시가 없으면 연재중) / 소설·만화 목록은 알 수 없음
      ongoing: type !== 'webtoon' ? '' : li.querySelector('.label-final') ? '완결' : '연재중',
    };
  }).filter(Boolean);
}

// 작품 찾기 화면에서 고른 것 (types·platforms 가 비어 있으면 전체)
// genre 와 keyword 는 둘 중 하나만 (하나를 고르면 다른 하나는 풀림)
let finderPick = { genre: '', keyword: '', types: new Set(), platforms: new Set() };

// 작품 찾기 화면의 탭 (info: 장르·종류·플랫폼 / keyword: 키워드), 펼친 키워드 묶음
let finderTab = 'info';
const kwOpen = new Set();

function openFinder(tab = 'info') {
  finderTab = tab;
  kwOpen.clear();
  $('kwFilter').value = '';
  renderFinder();
  openOverlay('finderPage');
  $('finderPage').scrollTop = 0;
}

const pickHTML = (kind, value, label, on) =>
  `<button type="button" class="f-pick${on ? ' active' : ''}" data-pick="${kind}" data-value="${esc(value)}">${esc(label)}</button>`;

function renderFinder() {
  // 탭: 고른 것이 있는 탭에는 점 표시
  const has = { info: !!finderPick.genre || finderPick.types.size > 0 || finderPick.platforms.size > 0, keyword: !!finderPick.keyword };
  document.querySelectorAll('#finderPage .f-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === finderTab);
    t.classList.toggle('dot', has[t.dataset.tab]);
    t.setAttribute('aria-selected', t.dataset.tab === finderTab);
  });
  $('finderInfo').hidden = finderTab !== 'info';
  $('finderKw').hidden = finderTab !== 'keyword';
  $('finderPage').classList.toggle('kw-mode', finderTab === 'keyword');

  // 장르는 검색 화면 "장르별 검색"과 같은 아이콘으로
  $('finderGenres').innerHTML = FINDER_GENRES.map((g) =>
    genreIconHTML(g.name, `data-pick="genre" data-value="${esc(g.name)}"`, finderPick.genre === g.name)).join('');
  $('finderTypes').innerHTML = Object.entries(TYPES).map(([t, label]) => pickHTML('types', t, label, finderPick.types.has(t))).join('');
  $('finderPlatforms').innerHTML = FINDER_PLATFORMS.map((p) => pickHTML('platforms', p, p, finderPick.platforms.has(p))).join('');
  renderKeywordCards();

  // 아래 버튼에 고른 장르·키워드 이름
  const picked = finderPick.genre || finderPick.keyword;
  $('finderRun').textContent = picked ? `'${picked}' 작품 찾기` : '작품 찾기';
}

// 키워드 탭: 묶음(세계관·소재·관계·캐릭터·분위기)마다 카드, 처음엔 세 줄까지만 보이고 ⌄ 로 펼침
// 검색칸에 쓰면 이름에 그 글자가 들어간 키워드만 (모든 묶음을 펼쳐서)
function renderKeywordCards() {
  const q = $('kwFilter').value.replace(/\s+/g, '');
  const match = (k) => !q || k.name.replace(/[\s/·>]/g, '').includes(q.replace(/[/·>]/g, ''));
  const cards = KEYWORD_GROUPS.map((g) => {
    const list = g.keywords.filter(match);
    if (!list.length) return '';
    // 고른 키워드가 들어 있는 묶음은 펼쳐 둠
    const open = q || kwOpen.has(g.name) || list.some((k) => k.name === finderPick.keyword);
    return `
      <section class="kw-card${open ? ' open' : ''}" data-group="${esc(g.name)}">
        <h3 class="kw-head"><span class="kw-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${g.icon}</svg></span>${esc(g.name)}</h3>
        <div class="picks kw-chips">${list.map((k) => pickHTML('keyword', k.name, k.name, finderPick.keyword === k.name)).join('')}</div>
        <button type="button" class="kw-fold" data-fold="${esc(g.name)}" aria-label="${open ? '접기' : '펼치기'}" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
      </section>`;
  }).join('');
  $('finderKeywords').innerHTML = cards || '<p class="msg">찾는 키워드가 없어요.</p>';
  // 세 줄이 넘는 묶음에만 펼치기 버튼 (검색 중에는 모두 펼쳐서 버튼 없음)
  if (!q && finderTab === 'keyword') {
    requestAnimationFrame(() => {
      document.querySelectorAll('#finderKeywords .kw-card').forEach((card) => {
        const chips = card.querySelector('.kw-chips');
        const rows = new Set([...chips.children].map((c) => c.offsetTop)).size;
        card.querySelector('.kw-fold').hidden = rows <= 3;
      });
    });
  }
}

// 고른 장르·종류·플랫폼·연재 상태로 받아 올 곳
// 플랫폼은 여기서 거르지 않고 모든 플랫폼에서 받은 뒤, 고른 플랫폼이 들어 있는 작품만 남김
// (그래야 고른 플랫폼 + 다른 플랫폼에도 있는 작품이 플랫폼 아이콘까지 다 나옴)
function finderSources(g) {
  const ok = (platform, ...types) => wantType(finderPick.types, ...types);
  return [
    (g.naver || g.naverTag) && ok('네이버웹툰', 'webtoon') && 'naverWebtoon',
    (g.kw || g.kwKey) && ok('카카오웹툰', 'webtoon') && 'kakaoWebtoon',
    (g.kp || (g.kpToon && ok('카카오페이지', 'webtoon', 'comic')) || (g.kpNovel && ok('카카오페이지', 'webnovel'))) && 'kakao',
    g.lz && ok('레진코믹스', 'webtoon') && 'lezhin',
    g.novel && ok('네이버 시리즈', 'webnovel') && 'seriesNovel',
    g.comic && ok('네이버 시리즈', 'webtoon', 'comic') && 'seriesComic',
    ((g.mbToon && ok('미스터블루', 'webtoon')) || (g.mbComic && ok('미스터블루', 'comic'))
      || (g.mbNovel && ok('미스터블루', 'webnovel'))) && 'mrblue',
  ].filter(Boolean);
}

function runFinder() {
  // 장르 또는 키워드 (키워드도 장르와 같은 모양이라 그대로 씀)
  const g = FINDER_GENRES.find((x) => x.name === finderPick.genre) || FINDER_KEYWORDS.find((x) => x.name === finderPick.keyword);
  if (!g) { toast('장르나 키워드를 골라 주세요'); return; }
  const sources = finderSources(g);
  if (!sources.length) { toast('이 조건으로 찾을 수 있는 곳이 없어요'); return; }
  searchState = {
    q: '', groups: new Map(), pages: {}, failed: [], loading: false, filter: { type: 'all', platform: 'all', ongoing: 'all' },
    finder: { genre: g, sources, types: new Set(finderPick.types), platforms: new Set(finderPick.platforms) },
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
    // 키보드는 검색창을 직접 눌렀을 때만 올라오게 (창을 열자마자 올라오면 아이폰에서 화면이 위로 밀림)
    $('searchPage').scrollTop = 0;
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
  $('genreIcons').innerHTML = FINDER_GENRES.map((g) => genreIconHTML(g.name, `data-genre="${esc(g.name)}"`)).join('');

  // 키워드 검색: 누르면 그 키워드로 작품 찾기 (제목 검색이 아니라 플랫폼 키워드·태그 목록)
  $('suggestKeywords').innerHTML = FINDER_KEYWORDS.filter((k) => k.hot).map((k) =>
    `<button type="button" class="chip chip-word" data-keyword="${esc(k.name)}">${esc(k.name)}</button>`).join('');
}

// 장르 아이콘 하나 (검색 화면 "장르별 검색"과 작품 찾기 화면에서 같이 씀)
function genreIconHTML(name, attrs, active = false) {
  const icon = GENRE_ICONS[name] || GENRE_ICONS.판타지;
  return `
    <button type="button" class="genre-icon${active ? ' active' : ''}" ${attrs} style="--g:${icon.color}">
      <span class="gi-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.path}</svg></span>
      <span class="gi-name">${esc(name)}</span>
    </button>`;
}

// 장르별 검색 아이콘: 장르마다 색 + 직접 그린 선 그림 (24x24)
const GENRE_ICONS = {
  '순정·로맨스': { color: '#e8456b', path: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>' },
  로판: { color: '#9b51e0', path: '<path d="M4 8l4 4 4-7 4 7 4-4-2 11H6z"/>' },
  판타지: { color: '#4a6cf7', path: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/><path d="M19 3v3M17.5 4.5h3"/>' },
  현판: { color: '#1b8ad6', path: '<path d="M3 21h18M5 21V10h5v11M10 21V4h9v17M13 8h3M13 12h3M13 16h3"/>' },
  무협: { color: '#9a6a3a', path: '<path d="M20 4 9 15M14 4h6v6M7 13l4 4M4 20l3-3"/>' },
  액션: { color: '#f06b1a', path: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>' },
  드라마: { color: '#2f9e5c', path: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>' },
  '공포·스릴러': { color: '#4b4f63', path: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>' },
  소년: { color: '#e5484d', path: '<path d="M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-5 5-5 8-1-1-2-2-2-4-2 2-2 5-2 7 0 5 3 8 7 8z"/>' },
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
    cover: useKwCover ? info.cover : bigCover(cover?.cover),
    coverAlts: coverAlts(group, useKwCover ? null : cover, true), // 표지를 못 불러올 때 대신 쓸 다른 플랫폼 표지
    coverSource: useKwCover ? '카카오웹툰' : cover ? SEARCH_SOURCES[cover.source].platform : '',
    platform: [...new Set(sorted.map((i) => SEARCH_SOURCES[i.source].platform))].join(', '),
    genre: info.genre || sorted.find((i) => i.genre)?.genre || '',
    ongoing: mergeOngoing([...sorted.map((i) => i.ongoing), info.ongoing]), // 연재중 / 완결
    desc: descs.sort((a, b) => b.length - a.length)[0] || '',
    tags: info.tags || [],
    loginOnly: !!info.loginOnly, // 소개를 로그인 없이는 못 받는 19세 작품
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
    if (r.loginOnly) info.loginOnly = true;
  }
  return info;
}

// 검색 결과의 작품 정보 더 불러오기 (정보 화면을 열 때 한 번만)
// - 대표 플랫폼 한 곳: 장르·태그·연재 상태·소개
// - 카카오웹툰이 있으면 같이: 대표 이미지 + 전체 소개 + 연재 상태
async function loadGroupInfo(state) {
  // 불러오는 동안은 흰 화면에 로딩 표시만 - 작품 정보와 표지 그림까지 다 받은 뒤에 화면을 보여줌
  // (너무 오래 걸리면 8초 뒤 있는 것만으로 보여줌)
  state.loading = true;
  renderDetail();
  const tooLong = new Promise((resolve) => setTimeout(() => resolve(null), 8000));

  // 작품 찾기 결과는 장르·키워드 목록을 받은 플랫폼만 들어 있어서, 제목 검색으로 다른 플랫폼도 찾아서 붙임
  if (searchState.finder && searchState.groups.get(state.group.key) === state.group) {
    await Promise.race([addOtherPlatforms(state.group), tooLong]);
    if (detailState !== state) return;
  }

  const items = state.group.items;
  const main = INFO_SOURCES.map((s) => items.find((i) => i.source === s)).find(Boolean);
  const kw = items.find((i) => i.source === 'kakaoWebtoon');
  const targets = [...new Set([main, kw].filter(Boolean))];
  if (!targets.length) { state.loading = false; renderDetail(); return; }

  const results = await Promise.race([
    Promise.allSettled(targets.map((i) => SEARCH_SOURCES[i.source].fetchInfo(i))),
    tooLong,
  ]);
  if (detailState !== state) return; // 그사이 화면을 닫았으면 무시
  state.info = mergeInfo((results || []).map((r) => (r.status === 'fulfilled' ? r.value : null)));
  // 장르·키워드가 없으면 형태가 다른 같은 작품(원작 소설 ↔ 웹툰판)에서 이미 받은 것을 씀
  const borrowed = otherForms(state.group).map((g) => g.info).find((i) => i?.genre || i?.tags?.length);
  if (borrowed) {
    if (!state.info.genre) state.info.genre = borrowed.genre || '';
    if (!state.info.tags?.length) state.info.tags = borrowed.tags || [];
  }
  state.group.info = state.info;
  if (results) await Promise.race([preloadImage(groupAsWork(state.group, state.info).cover), tooLong]);
  if (detailState !== state) return;
  state.loading = false;
  renderDetail();
}

// 작품 찾기 결과의 작품을 그 제목으로 검색해서 (사용자가 제목을 검색한 것과 같은 요청)
// 제목 검색과 같은 기준(제목·종류가 같으면 같은 작품)으로 다른 플랫폼 결과를 묶음에 넣음
// - 그 플랫폼에는 그 장르·키워드가 안 붙어 있어도 작품이 있으면 아이콘이 같이 보임
// - 제목이 같고 형태가 다른 작품(원작 소설 ↔ 웹툰판)은 묶지 않고 원작 카드 바로 뒤에 따로 카드로
// - 결과 카드가 화면에 보이면 저절로 (두 작품씩 차례로), 작품을 열 때도 (아직 안 했으면)
function addOtherPlatforms(group) {
  group.lookup ||= (async () => {
    group.searched = true;
    const main = mainItem(group);
    const found = await titleLookup(main.title);
    // 원작 소설·웹툰판 카드는 지금까지 불러온 목록 맨 끝에 붙임 (중간에 끼우면 뒤 카드가 다 밀려서 깜빡여 보임)
    const ranks = [...searchState.groups.values()].flatMap((g) => g.items.map((i) => i.rank ?? 0));
    const rank = Math.max(0, ...ranks) + 0.01;
    const touched = [group];
    for (const it of found) {
      if (it.type === main.type) {
        if (!group.items.some((i) => i.source === it.source)) group.items.push({ ...it });
      } else if (isNovel(it.type) !== isNovel(main.type) && searchState.finder) {
        const gKey = `${titleKey(main.title)}|${it.type}`;
        let other = searchState.groups.get(gKey);
        if (!other) {
          other = { key: gKey, items: [], order: searchState.groups.size };
          searchState.groups.set(gKey, other);
        }
        if (!other.items.some((i) => i.source === it.source)) other.items.push({ ...it, rank });
        if (!touched.includes(other)) touched.push(other);
      }
    }
    group.done = true;
    if (searchState.finder && searchState.groups.get(group.key) === group) refreshCards(group, touched);
  })();
  return group.lookup;
}

// 제목 검색 결과(같은 제목 작품만)를 휴대폰에 7일 저장 - 같은 작품을 다시 볼 때 플랫폼에 다시 묻지 않게
// (검색에 실패한 플랫폼이 있으면 저장하지 않고 다음에 다시 물어봄)
const LOOKUP_KEY = 'titleLookup2'; // 베스트도전을 뺀 뒤로 새로 저장 (예전 저장분은 안 씀)
const LOOKUP_MS = 7 * 24 * 60 * 60 * 1000;
function readLookups() {
  try { return JSON.parse(localStorage.getItem(LOOKUP_KEY)) || {}; } catch { return {}; }
}
try { localStorage.removeItem('titleLookup1'); } catch { /* 예전 저장분 정리 */ }
async function titleLookup(title) {
  const key = titleKey(title);
  const hit = readLookups()[key];
  if (hit && Date.now() - hit.t < LOOKUP_MS) return hit.found;
  const results = await Promise.allSettled(SEARCH_TARGETS.map(async (source) => [source, (await fetchSearch(source, title, 0)).items]));
  const found = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const [source, items] = r.value;
    // 플랫폼마다 종류별로 제목이 같은 첫 번째 결과만 (소개 글은 저장하지 않음 - 정보 화면에서 다시 받음)
    for (const it of items.filter((i) => titleKey(i.title) === key)) {
      if (!found.some((f) => f.source === source && f.type === it.type)) found.push({ ...it, source, desc: '' });
    }
  }
  if (results.every((r) => r.status === 'fulfilled')) {
    try {
      const all = readLookups();
      all[key] = { t: Date.now(), found };
      // 오래된 것부터 지워서 300개까지만
      const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
      for (const k of keys.slice(300)) delete all[k];
      for (const k of keys) if (Date.now() - all[k].t >= LOOKUP_MS) delete all[k];
      localStorage.setItem(LOOKUP_KEY, JSON.stringify(all));
    } catch { /* 저장 못 해도 이번에는 그대로 씀 */ }
  }
  return found;
}

// 결과 목록은 다시 그리지 않고(표지가 깜빡이지 않게) 카드의 플랫폼 아이콘만 바꾸고,
// 원작 소설·웹툰판 카드는 목록 맨 끝에 붙임 (위 카드들이 밀리지 않게)
function refreshCards(group, touched) {
  const box = $('s-results');
  const grid = box.querySelector('.s-grid');
  const cardOf = (g) => box.querySelector(`.s-item[data-key="${CSS.escape(g.key)}"]`);
  if (!grid) return;
  for (const g of touched) {
    const card = cardOf(g);
    if (card) {
      card.querySelector('.badges').outerHTML = searchBadgesHTML(g);
      // 새로 붙은 플랫폼 표지를 대체 표지로 (이미 회색 칸이 됐으면 그 표지로 되살림)
      const img = card.querySelector('.s-card-cover img[src]');
      const alts = coverAlts(g, null, true).filter((u) => !failedCovers.has(u) && u !== img?.getAttribute('src'));
      if (img) {
        if (alts.length) img.dataset.alts = alts.join(' ');
      } else {
        // 표지가 없던 카드(빈 칸)나 못 불러온 카드(회색 칸)
        const empty = card.querySelector('.s-card-cover .blocked-cover, .s-card-cover img:not([src])');
        if (empty && alts.length) {
          empty.outerHTML = `<img src="${esc(alts[0])}" onerror="coverError(this)" data-alts="${esc(alts.slice(1).join(' '))}" alt="" loading="lazy">`;
        }
      }
    } else if (passesFilters(g)) {
      grid.insertAdjacentHTML('beforeend', searchCardHTML(g));
      cardObserver?.observe(grid.lastElementChild);
      box.querySelector('.no-match')?.remove();
      const count = box.querySelector('.s-count');
      if (count) count.textContent = count.textContent.replace(/\d+(\+?)$/, (m, plus) => `${grid.children.length}${plus}`);
    }
  }
}

// 위쪽 플랫폼 필터를 골랐으면 그 플랫폼 결과만 더 불러옴
const wantPlatform = (source) => searchState.filter.platform === 'all' || inFilterPlatform(SEARCH_SOURCES[source].platform, searchState.filter.platform);

// 결과 목록에 보일 작품인지 (작품 찾기 조건 + 위쪽 필터) - renderSearchResults 와 같은 기준
function passesFilters(g) {
  const { finder, filter: f } = searchState;
  const platformOf = (i) => SEARCH_SOURCES[i.source].platform;
  const ongoing = mergeOngoing(g.items.map((i) => i.ongoing));
  return (!finder || ((!finder.types.size || finder.types.has(mainItem(g).type)) &&
      (!finder.platforms?.size || g.items.some((i) => [...finder.platforms].some((p) => inFilterPlatform(platformOf(i), p)))))) &&
    (f.type === 'all' || mainItem(g).type === f.type) &&
    (f.platform === 'all' || g.items.some((i) => inFilterPlatform(platformOf(i), f.platform))) &&
    (f.ongoing === 'all' || (f.ongoing === '완결' ? /완결/.test(ongoing) : ongoing === f.ongoing));
}

// 화면에 보이는 결과 카드부터 다른 플랫폼 찾기 (한 번에 두 작품씩)
let cardObserver = null;
const lookupQueue = [];
let lookupActive = 0;
function watchCards() {
  if (!searchState.finder || !('IntersectionObserver' in window)) return;
  cardObserver ||= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      cardObserver.unobserve(e.target);
      const g = searchState.groups.get(e.target.dataset.key);
      if (g && !g.lookup && !lookupQueue.includes(g)) lookupQueue.push(g);
    }
    pumpLookups();
  }, { root: $('searchPage'), rootMargin: '0px 0px 200px 0px' });
  cardObserver.disconnect();
  lookupQueue.length = 0; // 목록을 새로 그리면 보이는 카드부터 다시
  document.querySelectorAll('#s-results .s-card').forEach((c) => {
    if (!searchState.groups.get(c.dataset.key)?.lookup) cardObserver.observe(c);
  });
  // 플랫폼을 골랐으면 화면에 안 보이는(그 플랫폼이 아직 안 붙은) 작품도 전부 차례로 찾음
  if (searchState.filter.platform !== 'all') {
    for (const g of searchState.groups.values()) if (!g.lookup && !lookupQueue.includes(g)) lookupQueue.push(g);
    pumpLookups();
  }
}
function pumpLookups() {
  while (lookupActive < 2 && lookupQueue.length) {
    const g = lookupQueue.shift();
    if (searchState.groups.get(g.key) !== g || g.lookup) continue; // 그사이 다른 검색을 했거나 이미 찾음
    lookupActive++;
    addOtherPlatforms(g).catch(() => {}).finally(() => { lookupActive--; pumpLookups(); });
  }
  // 다 찾았으면 "찾는 중" 표시를 지움
  if (!lookupActive && !lookupQueue.length) {
    $('lookingNote')?.remove();
    const box = $('s-results');
    if (searchState.finder && !box.querySelector('.s-card') && !box.querySelector('.no-match')) {
      box.querySelector('.s-grid')?.insertAdjacentHTML('afterend', '<p class="msg no-match">조건에 맞는 작품이 없어요.</p>');
    }
  }
}

const isNovel = (type) => type === 'webnovel';

// 같은 제목인데 형태가 다른 작품 묶음 (원작 소설 ↔ 웹툰·만화판) - 지금 결과 안에서 찾음
function otherForms(group) {
  const key = titleKey(mainItem(group).title);
  const novel = isNovel(mainItem(group).type);
  return [...searchState.groups.values()].filter((g) => g !== group &&
    titleKey(mainItem(g).title) === key && isNovel(mainItem(g).type) !== novel);
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
      loginOnly: !now.desc && !found.desc && !!found.loginOnly,
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

// 같은 제목의 다른 형태 (웹소설이면 "웹툰판도 있어요", 웹툰·만화면 "원작 소설도 있어요") - 누르면 그 작품 정보로
function otherFormsHTML(group) {
  const others = otherForms(group);
  if (!others.length) return '';
  const title = isNovel(mainItem(group).type) ? '웹툰·만화로도 있어요' : '원작 소설도 있어요';
  return `
    <div class="detail-sec">
      <h3>${title}</h3>
      <div class="other-forms">${others.map((g) => searchRowHTML(g).replace('data-key="', 'data-other-form="')).join('')}</div>
    </div>`;
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
      </div>` : w.loginOnly ? `
      <div class="detail-sec">
        <h3>작품 소개</h3>
        <p class="detail-empty">19세 작품이라 플랫폼 로그인이 있어야 작품 소개를 볼 수 있어서 가져오지 못했어요.</p>
      </div>` : ''}

    ${w.tags?.length ? `
      <div class="detail-sec">
        <h3>키워드</h3>
        <div class="tag-list">${w.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
      </div>` : ''}

    ${!mine && detailState.group ? otherFormsHTML(detailState.group) : ''}

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
  // 필터 & 정렬: 칩·정렬 버튼을 누르면 고르는 창, 고르면 바로 적용
  $('libFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter-key]');
    if (chip) openPickSheet(chip.dataset.filterKey);
  });
  $('sortBtn').addEventListener('click', () => openPickSheet('sort'));
  $('pickList').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-pick-value]');
    if (!opt) return;
    const { pickKind, pickValue } = opt.dataset;
    if (pickKind === 'sort') view.sort = pickValue; else view[pickKind] = pickValue;
    $('pickSheet').close();
    render();
  });
  $('search').addEventListener('input', (e) => { view.query = e.target.value; render(); });

  // 카드 누르면 작품 정보 화면 열기
  const onCardClick = (e) => {
    if (e.target.closest('.go-link')) return; // 플랫폼 아이콘은 링크만 열고 정보 화면은 안 엶
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
  $('finderBanner').addEventListener('click', () => openFinder('info'));
  $('finderBack').addEventListener('click', closeOverlay);
  $('finderPage').addEventListener('click', (e) => {
    const tab = e.target.closest('.f-tab');
    if (tab) {
      finderTab = tab.dataset.tab;
      renderFinder();
      $('finderPage').scrollTop = 0;
      return;
    }
    const fold = e.target.closest('[data-fold]');
    if (fold) {
      const name = fold.dataset.fold;
      if (kwOpen.has(name)) kwOpen.delete(name); else kwOpen.add(name);
      fold.closest('.kw-card').classList.toggle('open', kwOpen.has(name));
      fold.setAttribute('aria-label', kwOpen.has(name) ? '접기' : '펼치기');
      return;
    }
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    const { pick, value } = btn.dataset;
    if (pick === 'genre' || pick === 'keyword') {
      finderPick[pick] = finderPick[pick] === value ? '' : value;
      // 장르와 키워드는 둘 중 하나만
      if (pick === 'genre' && finderPick.genre) finderPick.keyword = '';
      if (pick === 'keyword' && finderPick.keyword) finderPick.genre = '';
    } else {
      const set = finderPick[pick];
      if (set.has(value)) set.delete(value); else set.add(value);
    }
    renderFinder();
  });
  $('finderReset').addEventListener('click', () => {
    finderPick = { genre: '', keyword: '', types: new Set(), platforms: new Set() };
    $('kwFilter').value = '';
    renderFinder();
  });
  $('finderRun').addEventListener('click', runFinder);
  // 키워드 검색칸: 쓰는 대로 걸러 보여줌 (엔터는 키보드만 내림)
  $('kwFilter').addEventListener('input', renderKeywordCards);
  $('kwForm').addEventListener('submit', (e) => { e.preventDefault(); $('kwFilter').blur(); });
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
      finderPick = { genre: genre.dataset.genre, keyword: '', types: new Set(), platforms: new Set() };
      runFinder();
      return;
    }
    const keyword = e.target.closest('[data-keyword]');
    if (keyword) {
      finderPick = { genre: '', keyword: keyword.dataset.keyword, types: new Set(), platforms: new Set() };
      runFinder();
      return;
    }
    if (e.target.closest('#genreMore')) { openFinder(); return; }
    if (e.target.closest('#keywordMore')) { openFinder('keyword'); return; }
    const word = e.target.closest('[data-q]');
    if (word) runSearch(word.dataset.q);
    if (e.target.closest('#recentClear')) { saveRecentSearches([]); showSearchIntro(); }
    if (e.target.closest('#manualAdd')) openEditor(null);
  });
  // 작품 찾기 결과 보는 순서
  $('s-results').addEventListener('change', (e) => {
    if (!e.target.matches('.s-sort')) return;
    searchState.sort = e.target.value;
    renderSearchResults();
  });
  $('s-results').addEventListener('click', (e) => {
    if (e.target.closest('#s-more')) { searchPlatform(true); return; }
    // 종류 / 플랫폼 필터
    const filter = e.target.closest('[data-filter]');
    if (filter) {
      const { filter: kind, value } = filter.dataset;
      // 연재 상태는 다시 누르면 해제
      searchState.filter[kind] = kind === 'ongoing' && searchState.filter.ongoing === value ? 'all' : value;
      searchState.moreIdle = false;
      renderSearchResults();
      return;
    }
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
    // 같은 제목의 다른 형태 작품 정보로 바꿔 보기
    const otherForm = e.target.closest('[data-other-form]');
    if (otherForm) {
      const group = searchState.groups.get(otherForm.dataset.otherForm);
      if (group) {
        const mine2 = findInLibrary(group);
        openDetail(mine2 ? { workId: mine2.id } : { group });
      }
      return;
    }
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
  ['statusSheet', 'ratingSheet', 'pickSheet'].forEach((id) => {
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
    document.querySelectorAll('#calGrid .cal-cell').forEach((c) => c.classList.toggle('selected', c.dataset.date === cal.selected));
    renderCalDayList();
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
