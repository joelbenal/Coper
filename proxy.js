/**
 * NEXUS PROXY — Vercel Serverless Edge Proxy
 * /api/proxy?url=<encoded_url>
 *
 * Strips X-Frame-Options, CSP, and other blocking headers.
 * Rewrites relative links to go through the proxy.
 * Deploy free on Vercel (vercel.com) — no credit card needed.
 */

export const config = { runtime: 'edge' };

const BLOCKED_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'strict-transport-security', // keep for passthrough but note it
]);

const FORWARD_HEADERS = [
  'accept',
  'accept-language',
  'accept-encoding',
  'cache-control',
];

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('url');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (!target) {
    return jsonErr(400, 'Missing ?url= parameter');
  }

  let targetUrl;
  try {
    targetUrl = new URL(decodeURIComponent(target));
  } catch {
    return jsonErr(400, 'Invalid URL: ' + target);
  }

  // Only HTTP/HTTPS
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return jsonErr(403, 'Only http/https allowed');
  }

  // Build fetch headers — look like a real browser
  const fetchHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };

  // Forward safe incoming headers
  for (const h of FORWARD_HEADERS) {
    const val = req.headers.get(h);
    if (val) fetchHeaders[h] = val;
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: req.method === 'GET' ? 'GET' : req.method,
      headers: fetchHeaders,
      redirect: 'follow',
      // Edge runtime supports signal
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    return jsonErr(502, 'Upstream fetch failed: ' + err.message);
  }

  // Build response headers — strip blockers, inject CORS
  const responseHeaders = new Headers();

  for (const [key, val] of upstream.headers.entries()) {
    const k = key.toLowerCase();
    if (BLOCKED_HEADERS.has(k)) continue; // strip
    if (k === 'location') {
      // Rewrite redirect target through proxy
      try {
        const redirected = new URL(val, targetUrl);
        responseHeaders.set('Location', proxyHref(redirected.toString(), req.url));
      } catch {
        responseHeaders.set('Location', val);
      }
      continue;
    }
    responseHeaders.set(key, val);
  }

  // Inject CORS
  const cors = corsHeaders();
  for (const [k, v] of Object.entries(cors)) responseHeaders.set(k, v);

  // For HTML: rewrite links so in-page nav stays proxied
  const ct = upstream.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    const html = await upstream.text();
    const rewritten = rewriteHtml(html, targetUrl.toString(), req.url);
    responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
    responseHeaders.delete('content-encoding'); // we decoded it
    responseHeaders.delete('content-length');
    return new Response(rewritten, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  // Everything else: passthrough body
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

/* ── HTML rewriter — rewrites href/src/action/etc to route through proxy ── */
function rewriteHtml(html, base, reqUrl) {
  const baseUrl = new URL(base);

  // Inject base tag + script that rewrites dynamic navigation
  const inject = `
<base href="${base}">
<script>
(function(){
  const PROXY = ${JSON.stringify(new URL(reqUrl).origin + '/api/proxy?url=')};
  function rw(url){
    if(!url||url.startsWith('data:')||url.startsWith('blob:')||url.startsWith('#')||url.startsWith('javascript:')) return url;
    try{ const u=new URL(url, document.baseURI); return PROXY+encodeURIComponent(u.href); }catch(e){ return url; }
  }
  // Intercept <a> clicks
  document.addEventListener('click', function(e){
    const a = e.target.closest('a');
    if(!a) return;
    const href = a.getAttribute('href');
    if(!href) return;
    if(href.startsWith('#')||href.startsWith('javascript:')) return;
    try{
      const target = new URL(href, document.baseURI);
      window.parent.postMessage({type:'NEXUS_NAV', url: target.href},'*');
      e.preventDefault();
    }catch(ex){}
  });
  // Intercept form submit
  document.addEventListener('submit', function(e){
    const form = e.target;
    const action = form.action || document.location.href;
    try{
      const target = new URL(action, document.baseURI);
      window.parent.postMessage({type:'NEXUS_NAV', url: target.href},'*');
      e.preventDefault();
    }catch(ex){}
  });
})();
<\/script>
`;

  // Inject just after <head> or at start
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/(<head[\s>][^>]*>)/i, `$1${inject}`);
  } else {
    html = inject + html;
  }

  // Rewrite static src/href attributes pointing to absolute or relative paths
  html = html.replace(
    /((?:href|src|action|data-src)\s*=\s*["'])([^"'#javascript][^"']*)(["'])/gi,
    (match, pre, url, post) => {
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('//')) {
        // protocol-relative
        if (url.startsWith('//')) {
          url = baseUrl.protocol + url;
          return `${pre}${proxyHref(url, reqUrl)}${post}`;
        }
        return match;
      }
      try {
        const abs = new URL(url, base).href;
        return `${pre}${proxyHref(abs, reqUrl)}${post}`;
      } catch {
        return match;
      }
    }
  );

  return html;
}

function proxyHref(targetUrl, reqUrl) {
  const origin = new URL(reqUrl).origin;
  return `${origin}/api/proxy?url=${encodeURIComponent(targetUrl)}`;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
}

function jsonErr(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
