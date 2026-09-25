// Service Worker：只在 HTTPS 或 localhost 下注册（见 src/update.ts）。
// 构建时 vite.config.ts 把下面的占位替换成构建号，所以每次 build 都是一个新版本的 SW。
const CACHE = 'ccr-__BUILD_ID__'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return
  if (req.mode === 'navigate') e.respondWith(networkFirst(e))
  else if (new URL(req.url).pathname.startsWith('/assets/')) e.respondWith(cacheFirst(e))
  // 其余（/api、manifest、图标）不经过 SW
})

// 页面：优先走网络，离线才回退缓存。全是 hash 路由，统一存在 '/' 下
async function networkFirst(e) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(e.request)
    if (res.ok) e.waitUntil(cache.put('/', res.clone()))
    return res
  } catch (err) {
    const hit = await cache.match('/')
    if (hit) return hit
    throw err
  }
}

// 带 hash 的资源内容不会变，命中缓存就直接用
async function cacheFirst(e) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(e.request)
  if (hit) return hit
  const res = await fetch(e.request)
  if (res.ok) e.waitUntil(cache.put(e.request, res.clone()))
  return res
}
