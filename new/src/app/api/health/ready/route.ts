import { isServerDiscoveryReady } from "@/lib/competitions/discovery/server-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ready = await isServerDiscoveryReady();
  return Response.json({ ready }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
