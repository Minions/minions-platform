import { Env } from './types';
import { handlePublish } from './routes/publish';
import { handleYank } from './routes/yank';
import { handleMe } from './routes/me';
import { jsonResponse } from './response';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    try {
      if (pathname === '/publish' && method === 'POST') return handlePublish(request, env);
      if (pathname === '/yank' && method === 'POST') return handleYank(request, env);
      if (pathname === '/me' && method === 'GET') return handleMe(request, env);

      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: 'Internal Server Error', detail: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
