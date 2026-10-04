// Vercel function: vercel.json rewrites every /api/* request here as
// /api?__path=<rest>, and this restores the original URL before handing it to
// the same router the local server uses. `npm run build` compiles src/ to dist/.
import { handleApi } from "../dist/server/app.js";

export default function handler(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.searchParams.get("__path");
  if (path !== null) {
    url.searchParams.delete("__path");
    const query = url.searchParams.toString();
    req.url = `/api/${path}${query ? `?${query}` : ""}`;
  }
  return handleApi(req, res);
}
