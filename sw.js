// 서비스 워커: 앱 파일을 저장해 두고, 인터넷이 없어도 열리게 해줌
// 앱 파일을 수정해서 배포할 땐 아래 버전 숫자를 올려 주세요 (v1 → v2)
const CACHE = 'my-library-v4';
const FILES = ['./', './index.html', './style.css?v=4', './app.js?v=4', './manifest.json', './icon.svg', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 먼저 인터넷에서 최신 파일을 받고, 안 되면 저장해 둔 파일 사용
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
