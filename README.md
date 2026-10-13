# NEXUS PROXY TERMINAL

Liquid glass hacker terminal UI + serverless web proxy.  
Bypasses X-Frame-Options, CSP, and iframe blocking headers.

---

## DEPLOY FREE — 3 OPTIONS

### Option 1: Vercel (recommended, zero config)

```bash
npm i -g vercel
vercel login
vercel --prod
```

Done. Vercel gives you `yourproject.vercel.app` for free.

---

### Option 2: Netlify

1. Push to GitHub.
2. Go to netlify.com → New site from Git.
3. Build command: (none)
4. Publish directory: `public`
5. For the API function, move `api/proxy.js` → `netlify/functions/proxy.js`  
   and adjust the import to use Netlify's `Handler` type.

---

### Option 3: Cloudflare Pages

1. Push to GitHub.
2. cloudflare.com/pages → Connect repo.
3. Build: none, output: `public`.
4. Move `api/proxy.js` → `functions/api/proxy.js`.
5. Remove `export const config = { runtime: 'edge' }` (CF uses its own runtime).

---

## HOW IT WORKS

```
Browser ──> /api/proxy?url=<encoded> ──> Edge Function
                                              │
                                    Fetch upstream with
                                    browser-spoofed headers
                                              │
                                    Strip: X-Frame-Options
                                           Content-Security-Policy
                                           COEP / COOP / CORP
                                              │
                                    Rewrite: <a href> / <img src>
                                             <form action>
                                             Location redirects
                                              │
                                    Return patched HTML with
                                    in-page nav interceptor script
                                              │
                               <──────────── iframe loads clean page
```

The frontend `index.html` also has a fallback chain of 5 free iframe proxy
services it rotates through when the self-hosted `/api/proxy` isn't available
(e.g. during dev without vercel dev running).

---

## PROXY BYPASS CHAIN

Front-end fallback order (used when no self-hosted proxy):

1. `proxysite.one`
2. `proxysite.com`  
3. `hide.me`
4. `blockaway.net`
5. `croxyproxy.com`

Blocksi and similar school/corp extensions block by domain. Because each of
these proxies is a different domain and you're never hitting the actual target
domain from the browser, domain-level blocklists don't apply. The proxy domain
itself would need to be explicitly listed, which is rare for smaller proxies.

---

## SELF-HOSTED PROXY INTEGRATION

After deploying, update `index.html`:

Find `const IFRAME_PROXIES = [` and add your deployed URL at index 0:

```js
const IFRAME_PROXIES = [
  u => `https://YOUR-APP.vercel.app/api/proxy?url=${encodeURIComponent(u)}`,
  // ... rest of fallbacks
];
```

Now your own edge proxy runs first — fastest, cleanest, no third-party.

---

## FILES

```
nexus-proxy-terminal/
├── public/
│   └── index.html      ← Full terminal UI (standalone, no build needed)
├── api/
│   └── proxy.js        ← Vercel Edge Function proxy
├── vercel.json         ← Routing + header config
├── package.json
└── README.md
```
