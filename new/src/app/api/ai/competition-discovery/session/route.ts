import { deleteDiscoveryCurrentSession, getDiscoveryCurrentSession, patchDiscoveryCurrentSession, postDiscoverySession } from "@/lib/competitions/discovery/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = deleteDiscoveryCurrentSession;
export const PATCH = patchDiscoveryCurrentSession;
export const POST = postDiscoverySession;
export const GET = getDiscoveryCurrentSession;
