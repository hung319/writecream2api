/**
 * =================================================================================
 * Project: writecream-2api (Bun Edition)
 * Version: 2.0.0
 * Ported by: CezDev
 * * [Features]
 * - Native Bun Server
 * - Pseudo-Streaming (Text -> SSE)
 * - Headless (No UI)
 * - .env Configuration
 * =================================================================================
 */

const CONFIG = {
  PORT: parseInt(Bun.env.PORT || "3000"),
  API_MASTER_KEY: Bun.env.API_MASTER_KEY || "1",
  UPSTREAM_URL: Bun.env.UPSTREAM_URL || "https://www.writecream.com/wp-admin/admin-ajax.php",
  UPSTREAM_ORIGIN: Bun.env.UPSTREAM_ORIGIN || "https://www.writecream.com",
  MODELS: ["writecream-chat"],
  DEFAULT_MODEL: "writecream-chat",
};

// CORS Headers Helpers
const corsHeaders = (headers: Record<string, string> = {}) => ({
  ...headers,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
});

// Error Response Helper
const createErrorResponse = (message: string, status: number, code: string) => {
  return new Response(
    JSON.stringify({ error: { message, type: "api_error", code } }),
    {
      status,
      headers: corsHeaders({ "Content-Type": "application/json" }),
    }
  );
};

// --- Main Server Logic ---

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. CORS Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 2. Authentication
    // Cho phép bỏ qua auth nếu user truy cập root (để check health đơn giản) hoặc nếu config key là "1"
    if (url.pathname.startsWith("/v1/")) {
        const authHeader = req.headers.get("Authorization");
        const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
        
        if (CONFIG.API_MASTER_KEY !== "1" && token !== CONFIG.API_MASTER_KEY) {
            return createErrorResponse("Unauthorized: Invalid API Key", 401, "unauthorized");
        }
    }

    // 3. Routing
    if (url.pathname === "/v1/models") {
      return handleModelsRequest();
    } 
    
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const requestId = `chatcmpl-${crypto.randomUUID()}`;
      return handleChatCompletions(req, requestId);
    }

    // Default 404
    return createErrorResponse("Not Found", 404, "not_found");
  },
});

console.log(`🚀 Writecream-2api (Bun) is running on port ${CONFIG.PORT}`);

// --- Handlers ---

function handleModelsRequest() {
  const modelsData = {
    object: "list",
    data: CONFIG.MODELS.map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "writecream-2api-bun",
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

async function handleChatCompletions(req: Request, requestId: string) {
  try {
    const body = await req.json();
    const messages = body.messages || [];
    const isStream = body.stream === true;
    const model = body.model || CONFIG.DEFAULT_MODEL;

    // Construct FormData for Upstream
    const formData = new FormData();
    formData.append("action", "generate_chat");
    formData.append("query", JSON.stringify(messages));
    formData.append("link", "writecream.com");

    // Fetch Upstream
    const upstreamRes = await fetch(CONFIG.UPSTREAM_URL, {
      method: "POST",
      headers: {
        Accept: "*/*",
        Origin: CONFIG.UPSTREAM_ORIGIN,
        Referer: `${CONFIG.UPSTREAM_ORIGIN}/ai-chat/`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        "X-Request-ID": requestId,
      },
      body: formData,
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      return createErrorResponse(`Upstream Error: ${upstreamRes.status} - ${errText}`, 502, "upstream_error");
    }

    const data = await upstreamRes.json();
    
    // Validate Upstream Data
    if (!data.success || !data.data || typeof data.data.response_content !== 'string') {
        console.error("Invalid upstream response:", data);
        return createErrorResponse("Invalid response structure from upstream", 502, "bad_gateway");
    }

    const fullContent = data.data.response_content;

    // --- Stream Mode ---
    if (isStream) {
      const stream = createPseudoStream(fullContent, requestId, model);
      return new Response(stream, {
        headers: corsHeaders({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Trace-ID": requestId,
        }),
      });
    }

    // --- Non-Stream Mode ---
    const response = {
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: fullContent },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    return new Response(JSON.stringify(response), {
      headers: corsHeaders({ "Content-Type": "application/json" }),
    });

  } catch (e: any) {
    console.error("Internal Error:", e);
    return createErrorResponse(`Internal Server Error: ${e.message}`, 500, "internal_error");
  }
}

/**
 * Creates a ReadableStream that simulates typing effect (Pseudo-Streaming)
 */
function createPseudoStream(text: string, requestId: string, model: string) {
  const encoder = new TextEncoder();
  // Split by spaces to preserve word boundaries, simulate typing chunk by chunk
  const words = text.split(/(\s+)/); 

  return new ReadableStream({
    async start(controller) {
      for (const word of words) {
        if (!word) continue;

        const chunk = {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              delta: { content: word },
              finish_reason: null,
            },
          ],
        };
        
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        
        // Artificial delay for "Typing" effect (20-30ms)
        await new Promise((r) => setTimeout(r, 25));
      }

      // Final [DONE] chunk
      const finalChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}
