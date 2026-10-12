const CACHE_NAME = 'rewards-dashboard-pwa-v7'
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js'
]

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => response)
        .catch(() => caches.match('/index.html'))
    )
    return
  }

  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    )
    return
  }

  // 跨域资源（CDN 上的 chart.js）：保持 cache-first。它是版本固定的第三方库，
  // 每次回源只会变慢，而且 CDN 抽风时反而更脆。
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request))
    )
    return
  }

  // 同源静态资源：network-first，失败才回落缓存（离线仍可用）。
  //
  // 以前这里是 cache-first。ASSETS 只预缓存了 7 个文件，而 views/*.js、charts.js、
  // zh-cn.js、util.js 这些模块是靠下面的 put 按需进缓存的 —— 一旦进过，cache-first
  // 就永远拿缓存里的旧代码，于是每次改前端都必须手动硬刷新（Ctrl+F5）。而 sw.js
  // 自身的更新检查还有节流，部署后第一遍刷新照样是旧代码。
  // 顺序反过来：先问网络，成功就顺手更新缓存；网络不可用再回落到缓存。
  event.respondWith(
    fetch(request)
      .then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') return response
        const responseClone = response.clone()
        caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone))
        return response
      })
      .catch(() =>
        caches.match(request).then(cached => cached || caches.match('/index.html'))
      )
  )
})
