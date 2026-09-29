import { createLocalClientToken } from "@corely/modules-patches";
import { readPatchJson } from "@corely/modules-patches";
import { getPatchActor } from "@/server/patch-runtime";
import { localPatchRepository } from "@/server/local-patch-runtime";
import { patchProblem } from "@/server/patch-response";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    return Response.json(
      await createLocalClientToken(
        await getPatchActor(request),
        localPatchRepository(),
        await readPatchJson(request),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return patchProblem(error);
  }
}
