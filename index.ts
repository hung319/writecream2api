/**
 * =================================================================================
 * Project: writecream-2api (Bun Edition)
 * Version: 1.0.0-bun
 * Description: High-performance OpenAI-compatible proxy for Writecream.
 * Runtime: Bun v1.0+
 * =================================================================================
 */

// --- [Configuration] ---
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_URL: process.env.UPSTREAM_URL || "https://www.writecream.com/wp-admin/admin-ajax.php",
  UPSTREAM_ORIGIN: process.env.UPSTREAM_ORIGIN || "https://www.writecream.com",
  MODELS: ["writecream-chat"],
  DEFAULT_MODEL: "writecream-chat",
};

console.log(`🚀 Writecream-2API is starting on port ${CONFIG.PORT}...`);

// --- [Server Entry] ---
Bun.serve({
  port: CONFIG.PORT,
  async fetch(request) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // 2. API Routing
    if (url.pathname.startsWith('/v1/')) {
      return handleApi(request);
    }

    // 3. 404 Handler (No UI anymore)
    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  },
});

// --- [API Logic] ---

async function handleApi(request) {
  // Authentication Middleware
  const authHeader = request.headers.get('Authorization');
  // Allow logic: If env key is "1", allow anonymous (per original logic), otherwise check Bearer
  if (CONFIG.API_MASTER_KEY !== "1") {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return createErrorResponse('Unauthorized: Missing Bearer Token.', 401, 'unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== CONFIG.API_MASTER_KEY) {
      return createErrorResponse('Forbidden: Invalid API Key.', 403, 'invalid_api_key');
    }
  }

  const url = new URL(request.url);
  const requestId = `chatcmpl-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    if (request.method !== 'POST') return createErrorResponse('Method not allowed', 405, 'method_not_allowed');
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`Endpoint not supported: ${url.pathname}`, 404, 'not_found');
  }
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'writecream-2api-bun',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

async function handleChatCompletions(request, requestId) {
  try {
    const requestData = await request.json();
    
    // Construct FormData for Upstream
    const formData = new FormData();
    formData.append('action', 'generate_chat');
    formData.append('query', JSON.stringify(requestData.messages || []));
    formData.append('link', 'writecream.com');

    // Upstream Request
    const upstreamResponse = await fetch(CONFIG.UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Accept': '*/*',
        'Origin': CONFIG.UPSTREAM_ORIGIN,
        'Referer': `${CONFIG.UPSTREAM_ORIGIN}/ai-chat/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-Request-ID': requestId,
      },
      body: formData,
    });

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      console.error(`Upstream Error ${upstreamResponse.status}:`, errorBody);
      return createErrorResponse(`Upstream error: ${upstreamResponse.status}`, upstreamResponse.status, 'upstream_error');
    }

    const responseData = await upstreamResponse.json();
    
    // Validate Upstream Response
    if (!responseData.success || !responseData.data || !responseData.data.response_content) {
       console.error("Invalid upstream response:", responseData);
       return createErrorResponse('Invalid response structure from upstream', 502, 'bad_gateway');
    }

    const fullContent = responseData.data.response_content;
    const model = requestData.model || CONFIG.DEFAULT_MODEL;

    // Handle Streaming (Pseudo-Stream)
    if (requestData.stream !== false) {
      const stream = createPseudoStream(fullContent, requestId, model);
      return new Response(stream, {
        headers: corsHeaders({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Server-Trace-ID': requestId,
        }),
      });
    } else {
      // Handle Normal Response
      const openAIResponse = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return new Response(JSON.stringify(openAIResponse), {
        headers: corsHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'X-Server-Trace-ID': requestId,
        }),
      });
    }

  } catch (e) {
    console.error('Exception in chat completions:', e);
    return createErrorResponse(`Internal Server Error: ${e.message}`, 500, 'internal_server_error');
  }
}

/**
 * Converts a static text response into an OpenAI-compatible SSE stream with typewriter effect.
 */
function createPseudoStream(text, requestId, model) {
  const encoder = new TextEncoder();
  // Split by spaces to simulate token generation, preserving structure
  let words = text.split(/(\s+)/); 

  return new ReadableStream({
    async start(controller) {
      for (const word of words) {
        if (word) {
          const chunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: word },
              finish_reason: null,
            }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        // "Typewriter" delay simulation (25ms)
        await Bun.sleep(25); 
      }

      // Final closing chunk
      const finalChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
}

// --- [Helpers] ---

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
