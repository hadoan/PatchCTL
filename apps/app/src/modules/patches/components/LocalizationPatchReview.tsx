"use client";

import { useState } from "react";
import type { RepositoryLocalizationProposal } from "@corely/contracts";
import { validateLocalizationProposal } from "@patchctl/localization";

type Operation = RepositoryLocalizationProposal["operations"][number];

export function localizationReviewRows(
  proposal: RepositoryLocalizationProposal,
) {
  return proposal.operations.map((operation) => ({
    operation,
    namespace: operation.key.includes(".")
      ? operation.key.slice(0, operation.key.indexOf("."))
      : "Root",
    validation: validateLocalizationProposal(
      {
        key: operation.key!,
        sourceLocale: operation.sourceLocale!,
        sourceText: operation.sourceText!,
        sourceRevision: operation.sourceRevision!,
        targetLocale: operation.targetLocale!,
      },
      operation.targetAfter!,
    ),
  }));
}

function TextValue({ value }: { value: string | null }) {
  return (
    <pre className="whitespace-pre-wrap break-words text-sm">
      {value === null
        ? "Missing (no value)"
        : value === ""
          ? "Empty string"
          : value}
    </pre>
  );
}

function TranslationRow({
  operation,
  namespace,
  errors,
}: {
  operation: Operation;
  namespace: string;
  errors: ReturnType<typeof validateLocalizationProposal>["errors"];
}) {
  return (
    <article
      data-testid="localization-diff"
      className="rounded-xl border p-5 space-y-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold break-all">{operation.key}</h2>
        <span className="rounded border px-2 py-1 text-xs capitalize">
          {operation.translationStatus}
        </span>
      </div>
      <p className="text-sm text-muted-foreground break-all">
        {namespace} · {operation.sourcePath} → {operation.targetPath}
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="min-w-0 rounded border p-3">
          <h3 className="text-xs font-semibold mb-2">
            Source · {operation.sourceLocale}
          </h3>
          <TextValue value={operation.sourceText} />
        </div>
        <div className="min-w-0 rounded border p-3">
          <h3 className="text-xs font-semibold mb-2">
            Current · {operation.targetLocale}
          </h3>
          <TextValue value={operation.targetBefore} />
        </div>
        <div className="min-w-0 rounded border border-green-200 bg-green-50 p-3 text-green-950">
          <h3 className="text-xs font-semibold mb-2">
            Proposed · {operation.targetLocale}
          </h3>
          <TextValue value={operation.targetAfter} />
        </div>
      </div>
      <div className="text-xs text-muted-foreground break-all space-y-1">
        <p>Source revision: {operation.sourceRevision}</p>
        <p>
          Recorded translation source revision:{" "}
          {operation.recordedSourceRevision ?? "Unrecorded"}
        </p>
        <p>Target file revision: {operation.targetBlobSha}</p>
      </div>
      {errors.length ? (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-red-950"
        >
          <p className="font-semibold">Validation errors</p>
          <ul className="list-disc pl-5">
            {errors.map((error, index) => (
              <li key={`${error.code}-${index}`}>
                {error.code}: {error.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm">Structural validation passed.</p>
      )}
    </article>
  );
}

export function LocalizationPatchReview({
  proposal,
}: {
  proposal: RepositoryLocalizationProposal;
}) {
  const [locale, setLocale] = useState("");
  const [namespace, setNamespace] = useState("");
  const [status, setStatus] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const rows = localizationReviewRows(proposal);
  const locales = [
    ...new Set(rows.map((row) => row.operation.targetLocale)),
  ].sort();
  const namespaces = [...new Set(rows.map((row) => row.namespace))].sort();
  const shown = rows.filter(
    (row) =>
      (!locale || row.operation.targetLocale === locale) &&
      (!namespace || row.namespace === namespace) &&
      (!status || row.operation.translationStatus === status) &&
      (!errorsOnly || row.validation.errors.length > 0),
  );
  const counts = Object.fromEntries(
    locales.map((item) => [
      item,
      Object.fromEntries(
        ["missing", "stale", "unverified", "translated"].map((value) => [
          value,
          rows.filter(
            (row) =>
              row.operation.targetLocale === item &&
              row.operation.translationStatus === value,
          ).length,
        ]),
      ),
    ]),
  );
  const errorCount = rows.filter((row) => row.validation.errors.length).length;
  return (
    <section className="space-y-5" aria-label="Localization comparison">
      <div className="rounded-xl border p-5 space-y-2">
        <h2 className="font-semibold">Translation summary</h2>
        <p className="text-sm break-all">
          {proposal.repositoryUrl} · {proposal.baseBranch} · base commit{" "}
          {proposal.baseCommitSha}
        </p>
        {locales.map((item) => (
          <p key={item} className="text-sm" data-testid="locale-summary">
            {item}: {counts[item].missing} missing · {counts[item].stale} stale
            · {counts[item].unverified} unverified · {counts[item].translated}{" "}
            translated
          </p>
        ))}
        <p className="text-sm">
          {errorCount} entries with structural validation errors.
        </p>
        <p className="text-xs text-muted-foreground">
          Source and target file revisions were captured when the proposal was
          prepared. Current Git changes are checked before apply.
        </p>
      </div>
      <div className="flex flex-wrap gap-3 rounded-xl border p-4">
        <label className="text-sm">
          Locale
          <select
            aria-label="Filter locale"
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
            className="ml-2 rounded border bg-background p-2"
          >
            <option value="">All</option>
            {locales.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Namespace
          <select
            aria-label="Filter namespace"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            className="ml-2 rounded border bg-background p-2"
          >
            <option value="">All</option>
            {namespaces.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Status
          <select
            aria-label="Filter status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="ml-2 rounded border bg-background p-2"
          >
            <option value="">All</option>
            {["missing", "stale", "unverified", "translated"].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(event) => setErrorsOnly(event.target.checked)}
          />
          Validation errors only
        </label>
      </div>
      <p className="text-sm" role="status">
        Showing {shown.length} of {rows.length} entries.
      </p>
      {shown.length === 0 && <p>No entries match these filters.</p>}
      {shown.map((row) => (
        <TranslationRow
          key={row.operation.id}
          operation={row.operation}
          namespace={row.namespace}
          errors={row.validation.errors}
        />
      ))}
    </section>
  );
}
