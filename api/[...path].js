// Vercel function: every /api/* request lands here and goes to the same router
// the local server uses. `npm run build` compiles src/ to dist/ before deploy.
import { handleApi } from "../dist/server/app.js";

export default function handler(req, res) {
  return handleApi(req, res);
}
