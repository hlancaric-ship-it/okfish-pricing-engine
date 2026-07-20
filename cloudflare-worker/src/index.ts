export interface Env {
  VIP_KV: KVNamespace;
  SECRET_TOKEN: string;
}

let cachedActiveVersion: string | null = null;
let cachedActiveVersionExpires = 0;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- HEALTH CHECK ---
    if (request.method === "GET" && url.pathname === "/v1/health") {
      let statsStr = await env.VIP_KV.get("health_stats");
      let activeVersion = await env.VIP_KV.get("active_version");
      
      let customers = 0;
      if (statsStr) {
        try { customers = JSON.parse(statsStr).customers || 0; } catch (e) {}
      }
      
      return new Response(JSON.stringify({
        status: "ok",
        version: activeVersion || "none",
        customers: customers,
        build: "1.0.0"
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // --- FRONTEND: GET /v1/discount/{hash} ---
    if (request.method === "GET" && url.pathname.startsWith("/v1/discount/")) {
      const hash = url.pathname.split("/").pop();
      
      if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
        return new Response(JSON.stringify({
          v: 1,
          discount: 0
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }

      const now = Date.now();
      if (!cachedActiveVersion || now > cachedActiveVersionExpires) {
        cachedActiveVersion = await env.VIP_KV.get("active_version");
        cachedActiveVersionExpires = now + 60 * 1000;
      }
      
      let discount = 0;
      if (cachedActiveVersion) {
        const discountStr = await env.VIP_KV.get(`${cachedActiveVersion}:${hash}`);
        discount = discountStr ? parseInt(discountStr, 10) : 0;
      }
      
      const payload = JSON.stringify({ v: 1, discount });
      const eTag = `W/"v1-${hash}-${discount}"`;
      
      if (request.headers.get("If-None-Match") === eTag) {
        return new Response(null, {
          status: 304,
          headers: {
            ...corsHeaders,
            "Cache-Control": "public, max-age=3600",
            "ETag": eTag
          }
        });
      }

      return new Response(payload, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
          "ETag": eTag
        }
      });
    }

    // --- Ochrana všech POST /v1/import endpointů ---
    if (request.method === "POST" && url.pathname.startsWith("/v1/import")) {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || authHeader !== `Bearer ${env.SECRET_TOKEN}`) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }

      try {
        // 1. BEGIN IMPORT
        if (url.pathname === "/v1/import/begin") {
          const version = Date.now().toString();
          
          await env.VIP_KV.put(
            `import:${version}`,
            JSON.stringify({
              created: Date.now()
            })
          );
          
          return new Response(JSON.stringify({ version }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // 2. UPLOAD CHUNK
        if (url.pathname === "/v1/import/chunk") {
          const body = await request.json() as { version: string, customers: { hash: string; discount: number }[] };
          if (!body.version || !Array.isArray(body.customers)) {
            return new Response("Invalid body format", { status: 400, headers: corsHeaders });
          }
          
          if (body.customers.length > 250) {
            return new Response(
              JSON.stringify({
                error: "Maximum chunk size is 250."
              }),
              {
                status: 400,
                headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json"
                }
              }
            );
          }

          for (const item of body.customers) {
            if (!/^[a-f0-9]{64}$/.test(item.hash)) {
                return new Response(
                    JSON.stringify({
                        error: "Invalid hash."
                    }),
                    {
                        status: 400,
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    }
                );
            }

            if (!Number.isInteger(item.discount)) {
                return new Response(
                    JSON.stringify({
                        error: "Invalid discount."
                    }),
                    {
                        status: 400,
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    }
                );
            }

            if (item.discount < 0 || item.discount > 100) {
                return new Response(
                    JSON.stringify({
                        error: "Discount out of range."
                    }),
                    {
                        status: 400,
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    }
                );
            }
          }
          
          await Promise.all(body.customers.map(item => 
            env.VIP_KV.put(`${body.version}:${item.hash}`, item.discount.toString())
          ));

          return new Response(JSON.stringify({ success: true, count: body.customers.length }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // 3. FINISH IMPORT
        if (url.pathname === "/v1/import/finish") {
          const body = await request.json() as { version: string, customers: number };
          if (!body.version) {
             return new Response("Invalid body format", { status: 400, headers: corsHeaders });
          }
          
          const session = await env.VIP_KV.get(`import:${body.version}`);

          if (!session) {
            return new Response(
              JSON.stringify({
                error: "Unknown import session."
              }),
              {
                status: 400,
                headers: {
                  ...corsHeaders,
                  "Content-Type": "application/json"
                }
              }
            );
          }
          
          const oldVersion = await env.VIP_KV.get("active_version");
          
          // Aktivace nové verze
          await env.VIP_KV.put("active_version", body.version);
          await env.VIP_KV.put("health_stats", JSON.stringify({ customers: body.customers }));
          
          cachedActiveVersion = body.version;
          cachedActiveVersionExpires = Date.now() + 60 * 1000;
          
          await env.VIP_KV.delete(`import:${body.version}`);
          
          return new Response(JSON.stringify({ 
            activeVersion: body.version, 
            oldVersion: oldVersion || null, 
            customers: body.customers 
          }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        // 4. CLEANUP (Garbage Collection)
        if (url.pathname === "/v1/import/cleanup") {
            const body = await request.json() as {
                version: string;
            };

            if (!body.version) {
                return new Response(
                    JSON.stringify({
                        error: "Missing version."
                    }),
                    {
                        status: 400,
                        headers: {
                            ...corsHeaders,
                            "Content-Type": "application/json"
                        }
                    }
                );
            }

            let cursor: string | undefined = undefined;
            const keys: string[] = [];

            do {
                const list = await env.VIP_KV.list({
                    prefix: `${body.version}:`,
                    limit: 250,
                    cursor
                });

                keys.push(...list.keys.map(k => k.name));

                cursor = list.list_complete
                    ? undefined
                    : list.cursor;

            } while (cursor);

            await Promise.all(
                keys.map(key => env.VIP_KV.delete(key))
            );

            return new Response(
                JSON.stringify({
                    success: true,
                    deleted: keys.length
                }),
                {
                    status: 200,
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "application/json"
                    }
                }
            );
        }

      } catch (err: any) {
        return new Response(`Error: ${err.message}`, { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
