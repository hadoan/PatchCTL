"use client";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/auth/auth-context";
import { patchClient } from "../patches-api";
import { LocalClientConnectionGuide } from "../components/LocalClientConnectionGuide";
import {
  LocalizationPatchReview,
  localizationReviewRows,
} from "../components/LocalizationPatchReview";

function Value({ value }: { value: unknown }) {
  return (
    <pre className="whitespace-pre-wrap break-words text-sm">
      {value === null
        ? "Null (no value)"
        : value === ""
          ? "Empty string"
          : String(value)}
    </pre>
  );
}
export function LocalPatchReview({ id }: { id?: string }) {
  const auth = useAuth();
  const [after, setAfter] = useState<string | undefined>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const scope = [auth.user?.userId, auth.user?.activeTenantId];
  const enabled = !auth.isLoading && auth.isAuthenticated;
  const actor = useQuery({
    queryKey: ["local-actor", ...scope],
    queryFn: () => patchClient.actor(),
    enabled,
    retry: false,
  });
  const list = useQuery({
    queryKey: ["local-patches", ...scope, after],
    queryFn: () => patchClient.localPatches(after),
    enabled: enabled && !id,
    retry: false,
  });
  const detail = useQuery({
    queryKey: ["local-patch", ...scope, id],
    queryFn: () => patchClient.localPatch(id!),
    enabled: enabled && !!id,
    retry: false,
  });
  const activeMembership = auth.user?.memberships.find(
    (membership) => membership.tenantId === auth.user?.activeTenantId,
  );
  const localizationRows =
    detail.data && "kind" in detail.data.proposal
      ? localizationReviewRows(detail.data.proposal)
      : null;
  const hasLocalizationErrors =
    localizationRows?.some((row) => !row.validation.valid) ?? false;
  async function decide(decision: "APPROVED" | "REJECTED") {
    if (!detail.data) return;
    setBusy(true);
    setError("");
    try {
      await patchClient.localDecide(
        detail.data.id,
        detail.data.revision,
        decision,
      );
    } catch {
      setError(
        "The decision could not be saved. Refresh and review the current revision before retrying.",
      );
    } finally {
      await detail.refetch();
      setBusy(false);
    }
  }
  if (auth.isLoading) return <p role="status">Loading session…</p>;
  if (!auth.isAuthenticated)
    return (
      <p>
        <Link href="/login" className="underline">
          Sign in
        </Link>{" "}
        to review patches.
      </p>
    );
  const query = id ? detail : list;
  return (
    <section className="mx-auto max-w-5xl space-y-6 p-2">
      <header>
        <p className="text-sm text-muted-foreground">PatchCTL / Human review</p>
        <h1 className="text-3xl font-semibold">
          {id ? (detail.data?.proposal.title ?? "Review patch") : "Patches"}
        </h1>
        <p className="mt-2 text-muted-foreground">
          Agents propose. Humans review the exact immutable change.
        </p>
      </header>
      <div className="flex flex-wrap gap-3">
        {id && (
          <Link href="/patches" className="rounded border px-4 py-2">
            All patches
          </Link>
        )}
        <button
          className="rounded border px-4 py-2"
          onClick={() => void query.refetch()}
        >
          Refresh
        </button>
      </div>
      {query.isLoading && <p role="status">Loading patches…</p>}
      {(query.isError || error) && (
        <p role="alert">
          {error ||
            "Patch data is unavailable. Check your session and Tenant access, then refresh."}
        </p>
      )}
      {!id && (
        <>
          {list.data?.items.length === 0 && <p>No patches to review.</p>}
          <ul className="space-y-3">
            {list.data?.items.map((patch) => (
              <li key={patch.id} className="rounded-xl border p-5">
                <Link
                  className="font-semibold underline"
                  href={`/patches/${patch.id}`}
                >
                  {patch.proposal.title}
                </Link>
                <p className="mt-2">
                  {patch.status} · {patch.proposal.operations.length}{" "}
                  {"kind" in patch.proposal ? "entries" : "records"} ·{" "}
                  {patch.creator.kind} {patch.creator.id}
                </p>
              </li>
            ))}
          </ul>
          <div className="flex gap-3">
            <button
              className="rounded border px-4 py-2 disabled:opacity-40"
              disabled={!after}
              onClick={() => setAfter(undefined)}
            >
              First page
            </button>
            <button
              className="rounded border px-4 py-2 disabled:opacity-40"
              disabled={!list.data?.nextCursor}
              onClick={() => setAfter(list.data?.nextCursor ?? undefined)}
            >
              Next page
            </button>
          </div>
          {auth.user?.activeTenantId && activeMembership?.tenantName && (
            <LocalClientConnectionGuide
              tenantId={auth.user.activeTenantId}
              tenantName={activeMembership.tenantName}
            />
          )}
        </>
      )}
      {detail.data && (
        <>
          <div className="rounded-xl border p-5 space-y-2">
            <p>
              Status:{" "}
              <strong data-testid="patch-state">{detail.data.status}</strong>
            </p>
            <p data-testid="affected-count">
              {detail.data.proposal.operations.length}{" "}
              {"kind" in detail.data.proposal ? "entries" : "records"} · Created
              by {detail.data.creator.kind} {detail.data.creator.id}
            </p>
            <p className="break-all text-xs text-muted-foreground">
              Revision {detail.data.revision}
            </p>
            {detail.data.status === "APPROVED" &&
              !("kind" in detail.data.proposal) && (
                <p>
                  Approved. Local apply is not implemented yet, so PostgreSQL
                  remains unchanged.
                </p>
              )}
            {detail.data.failureCode && (
              <p role="alert">
                Local execution reported {detail.data.failureCode}. Prepare a
                new patch against the current content.
              </p>
            )}
          </div>
          {"kind" in detail.data.proposal ? (
            <LocalizationPatchReview proposal={detail.data.proposal} />
          ) : (
            detail.data.proposal.operations.map((op) => (
              <article
                key={op.id}
                data-testid="record-diff"
                className="rounded-xl border p-5 space-y-4"
              >
                <h2 className="font-semibold break-all">
                  {op.resource}/{op.recordId}
                </h2>
                {Object.keys(op.after)
                  .filter((key) => op.before[key] !== op.after[key])
                  .map((field) => (
                    <div key={field}>
                      <h3 className="font-medium mb-2">{field}</h3>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="min-w-0 rounded border border-red-200 bg-red-50 p-3 text-red-950">
                          <p className="text-xs font-semibold mb-2">Before</p>
                          <Value value={op.before[field]} />
                        </div>
                        <div className="min-w-0 rounded border border-green-200 bg-green-50 p-3 text-green-950">
                          <p className="text-xs font-semibold mb-2">After</p>
                          <Value value={op.after[field]} />
                        </div>
                      </div>
                    </div>
                  ))}
              </article>
            ))
          )}
          {detail.data.status === "SUBMITTED" &&
            (actor.data?.kind === "human" &&
            actor.data.permissions.includes("review") ? (
              <div className="flex gap-3">
                <button
                  disabled={busy}
                  className="rounded border px-5 py-2 disabled:opacity-40"
                  onClick={() => void decide("REJECTED")}
                >
                  Reject
                </button>
                <button
                  disabled={busy || hasLocalizationErrors}
                  className="rounded bg-primary text-primary-foreground px-5 py-2 disabled:opacity-40"
                  onClick={() => void decide("APPROVED")}
                >
                  Approve
                </button>
                {hasLocalizationErrors && (
                  <p role="alert">
                    Approval is unavailable while translations have validation
                    errors.
                  </p>
                )}
              </div>
            ) : (
              <p>Human reviewer access is required to approve or reject.</p>
            ))}
          <section className="rounded-xl border p-5">
            <h2 className="font-semibold mb-3">Audit history</h2>
            <ol className="space-y-2">
              {detail.data.events.map((event, index) => (
                <li key={index} className="break-words text-sm">
                  {event.event} · {event.actor.kind} {event.actor.id} ·{" "}
                  {new Date(event.timestamp).toLocaleString()}
                </li>
              ))}
            </ol>
            <p className="mt-3 text-sm text-muted-foreground">
              {"kind" in detail.data.proposal
                ? "Git application and conflict results are reported by the authenticated local client."
                : "Execution outcomes are reported by the authenticated local client. The server never connects to the content database."}
            </p>
          </section>
        </>
      )}
    </section>
  );
}
