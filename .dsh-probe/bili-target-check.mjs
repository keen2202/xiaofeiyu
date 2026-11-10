const res = await fetch('https://api.bilibili.com/x/web-interface/card?mid=508187015', { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(8000) });
const body = await res.json().catch(() => ({}));
console.log(JSON.stringify({ http: res.status, code: body.code, message: body.message, name: body.data?.card?.name || null, relation: body.data?.relation || null }));
