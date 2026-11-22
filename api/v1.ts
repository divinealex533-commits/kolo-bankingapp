// The Kolo API. The app calls POST /api/v1 with { action, ...params }.
import { handler } from "../server/http";
import { route } from "../server/actions";

const run = handler(route);
export const POST = (req: Request) => run(req);
export const OPTIONS = (req: Request) => run(req);
