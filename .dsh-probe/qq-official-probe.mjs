const targets = [
  { method: 'GET', url: 'https://api.bot.qq.com/' },
  { method: 'POST', url: 'https://api.bot.qq.com/get_status', body: '{}' },
  { method: 'POST', url: 'https://api.bot.qq.com/get_login_info', body: '{}' }
];
for (const target of targets) {
  try {
    const res = await fetch(target.url, {
      method: target.method,
      headers: { 'content-type': 'application/json' },
      body: target.body,
      signal: AbortSignal.timeout(10000)
    });
    const text = await res.text().catch(() => '');
    console.log(JSON.stringify({ url: target.url, status: res.status, contentType: res.headers.get('content-type'), bodyStart: text.slice(0, 160) }));
  } catch (error) {
    console.log(JSON.stringify({ url: target.url, error: error?.cause?.code || error?.name || String(error) }));
  }
}
