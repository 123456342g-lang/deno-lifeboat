import { greet, GreetOptions } from "@/greet.ts";
import { Config, loadConfig } from "./config.ts";

const config: Config = await loadConfig(new URL("./config.json", import.meta.url));
const options: GreetOptions = { punctuation: Deno.args.includes("--excited") ? "!!!" : "!" };

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/":
      return new Response(greet(config.name, options));
    case "/env":
      return Response.json({ greeting: Deno.env.get("GREETING") ?? null, hasHome: Deno.env.has("HOME") });
    case "/echo":
      return new Response(await req.text(), { headers: { "content-type": req.headers.get("content-type") ?? "text/plain" } });
    case "/cookies": {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("cookies", { headers });
    }
    default:
      return new Response("not found", { status: 404 });
  }
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8000");
  Deno.serve({ port, onListen: ({ port }) => console.log(`ready on ${port}`) }, handler);
}
