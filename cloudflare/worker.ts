export interface Env {
  UPSTREAM_BASE_URL: string;
}

function buildUpstreamUrl(request: Request, upstreamBaseUrl: string) {
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(upstreamBaseUrl);
  upstreamUrl.pathname = incomingUrl.pathname;
  upstreamUrl.search = incomingUrl.search;
  return upstreamUrl.toString();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.UPSTREAM_BASE_URL) {
      return new Response("UPSTREAM_BASE_URL is required.", { status: 500 });
    }

    const upstreamResponse = await fetch(buildUpstreamUrl(request, env.UPSTREAM_BASE_URL), {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    return new Response(upstreamResponse.body, upstreamResponse);
  },
};
