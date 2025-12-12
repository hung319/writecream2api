/**
 * =================================================================================
 * Project: writecream-2api (Bun Edition)
 * Version: 1.1.0-bun (Stream Aggregation Support)
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

    // 3. 404 Handler
    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  },
});

// --- [API Logic] ---

async function handleApi(request: Request) {
  // Authentication Middleware
  const authHeader = request.headers.get('Authorization');
  // Logic: If env key is "1", allow anonymous. Otherwise check Bearer token.
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

async function handleChatCompletions(request: Request, requestId: string) {
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

    // --- Data Processing Logic ---
    const rawResponseBody = await upstreamResponse.text();
    let fullContent = "";

    try {
        // Attempt 1: Parse as standard JSON (Old format or clean response)
        const jsonData = JSON.parse(rawResponseBody);
        if (jsonData.data && jsonData.data.response_content) {
            fullContent = jsonData.data.response_content;
        } else if (jsonData.choices) {
             // Standard OpenAI-like JSON (Non-stream)
             fullContent = jsonData.choices[0].message.content;
        }
    } catch (e) {
        // Attempt 2: If JSON parse fails, assume it's the Stream format (SSE lines)
        // This handles inputs like: {"id":...}\n data: {"id"...}
        fullContent = accumulateStreamData(rawResponseBody);
    }

    // Final check if content was extracted
    if (!fullContent) {
        console.error("Failed to extract content from upstream response. Raw preview:", rawResponseBody.substring(0, 200));
        return createErrorResponse('Upstream response format not recognized or empty', 502, 'bad_gateway');
    }

    const model = requestData.model || CONFIG.DEFAULT_MODEL;

    // --- Response Construction ---

    // Case 1: Client wants Stream (stream: true)
    if (requestData.stream !== false) {
      // Re-stream the aggregated content (Pseudo-stream)
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
      // Case 2: Client wants JSON (stream: false)
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

  } catch (e: any) {
    console.error('Exception in chat completions:', e);
    return createErrorResponse(`Internal Server Error: ${e.message}`, 500, 'internal_server_error');
  }
}

/**
 * Parses raw SSE/Stream text (mixed with potential JSON lines) and aggregates content.
 * Handles formats: 
 * 1. {"id":...} 
 * 2. data: {"id":...}
 */
function accumulateStreamData(rawData: string): string {
  const lines = rawData.split('\n');
  let fullText = "";

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines or DONE signal
    if (!trimmed || trimmed === 'data: [DONE]') continue;

    let jsonStr = trimmed;
    // Remove 'data: ' prefix if present
    if (trimmed.startsWith('data: ')) {
        jsonStr = trimmed.slice(6);
    }

    try {
        const json = JSON.parse(jsonStr);
        // Extract content from delta structure
        if (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) {
            fullText += json.choices[0].delta.content;
        }
    } catch (e) {
        // Ignore parsing errors for individual lines (best effort)
    }
  }
  
  return fullText;
}

/**
 * Converts a static text response into an OpenAI-compatible SSE stream with typewriter effect.
 */
function createPseudoStream(text: string, requestId: string, model: string) {
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
        // "Typewriter" delay simulation (20ms for faster response)
        await Bun.sleep(20); 
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

function createErrorResponse(message: string, status: number, code: string) {
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

function corsHeaders(headers: any = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
