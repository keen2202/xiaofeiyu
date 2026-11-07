export function responseJson(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    }
  };
}

export function createMockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || null
    };
    calls.push(call);
    const result = await handler(call);
    if (result instanceof Error) throw result;
    return result;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

export const NAV_WBI = {
  code: 0,
  data: {
    isLogin: true,
    mid: 1001,
    uname: 'tester',
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
    }
  }
};
