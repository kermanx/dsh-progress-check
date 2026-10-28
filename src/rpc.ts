/** Progress RPC carried by Connection's authenticated shared API routes. */
import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema, transportError } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { GENERATE_METHOD, PRESENCE_METHOD, PROGRESS_CHANNEL } from './protocol.ts'

/** Register owner-only routes without the dedicated channel's WebServer context lookup. */
export function registerProgressRpc(ctx: Context, handler: ConnectionRpcHandler): void {
  for (const endpoint of [GENERATE_METHOD, PRESENCE_METHOD]) {
    ctx.connection.fetch.register({
      path: `${PROGRESS_CHANNEL}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response(null, { status: 415 })
        }
        let body: unknown
        try { body = await request.json() } catch { return new Response(null, { status: 400 }) }
        const parsed = clientRequestSchema.safeParse(body)
        if (!parsed.success || parsed.data.method !== endpoint) return new Response(null, { status: 400 })
        const result = await handler(endpoint, parsed.data.payload, request.signal, ctx.connection.browserPeer)
          .catch(transportError)
        return Response.json({ type: 'server-response', rpcId: parsed.data.rpcId, result })
      },
    })
  }
}
