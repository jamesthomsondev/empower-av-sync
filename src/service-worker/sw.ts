/// <reference lib="webworker" />
/**
 * Hand-written service worker (injectManifest). Precaches the app shell + the bundled
 * looping video and soundtrack so the experience runs fully offline after first load.
 * Only joining a session (WebRTC signaling) needs the network.
 */
import { clientsClaim } from 'workbox-core'
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { RangeRequestsPlugin } from 'workbox-range-requests'

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

self.skipWaiting()
clientsClaim()

precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/\/[^/?]+\.[^/]+$/],
  }),
)

// Media (audio/video) cache-first with Range support for seeking, in case anything is
// fetched at runtime rather than served from precache.
registerRoute(
  ({ request }) => request.destination === 'audio' || request.destination === 'video',
  new CacheFirst({
    cacheName: 'media-cache',
    plugins: [
      new RangeRequestsPlugin(),
      new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 7 * 24 * 60 * 60 }),
    ],
  }),
)
