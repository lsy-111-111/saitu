import { postDiscoveryCancel } from "@/lib/competitions/discovery/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return postDiscoveryCancel(request, (await context.params).id);
}
