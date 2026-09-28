import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const id = "6e753913-798c-4af2-b97b-0c7f89ce7d2a";
const revision = "a".repeat(64);
const hash = (key: string, text: string) =>
  createHash("sha256")
    .update(JSON.stringify(["en", key, text]))
    .digest("hex");
const operation = (input: {
  id: string;
  key: string;
  sourceText: string;
  targetLocale: string;
  targetBefore: string | null;
  targetAfter: string;
  translationStatus: "missing" | "stale";
  recordedSourceRevision: string | null;
}) => ({
  ...input,
  sourceLocale: "en",
  sourceRevision: hash(input.key, input.sourceText),
  sourcePath: "locales/en.json",
  targetPath: `locales/${input.targetLocale}.json`,
  targetBlobSha: "d".repeat(40),
});

async function mockReview(
  page: Page,
  options: {
    agent?: boolean;
    invalid?: boolean;
    status?: "SUBMITTED" | "APPROVED" | "APPLIED";
  } = {},
) {
  const operations = [
    operation({
      id: "798c0375-5fb1-46f4-85d6-8c25442e568d",
      key: "checkout.cancel",
      sourceText: "Cancel",
      targetLocale: "de",
      targetBefore: null,
      targetAfter: "Abbrechen",
      translationStatus: "missing",
      recordedSourceRevision: null,
    }),
    operation({
      id: "e65ff68d-b329-422b-bd78-a1a1d60fdb98",
      key: "checkout.pay",
      sourceText: "Pay now",
      targetLocale: "de",
      targetBefore: "Bezahlen",
      targetAfter: "Jetzt bezahlen",
      translationStatus: "stale",
      recordedSourceRevision: "e".repeat(64),
    }),
    operation({
      id: "8052c630-89c1-4f90-9d69-326a63fb818a",
      key: "profile.name",
      sourceText: "Name",
      targetLocale: "fr",
      targetBefore: null,
      targetAfter: "Nom",
      translationStatus: "missing",
      recordedSourceRevision: null,
    }),
  ];
  if (options.invalid) operations[0].sourceRevision = "c".repeat(64);
  const patch = {
    id,
    tenantId: "tenant",
    revision,
    status: options.status ?? "SUBMITTED",
    proposal: {
      kind: "repository-localization",
      id,
      connectionId: "e5f80241-6c20-4de6-a793-c6b67d9f7eb8",
      repositoryUrl: "https://github.com/example/app.git",
      baseBranch: "main",
      baseLocale: "en",
      baseCommitSha: "b".repeat(40),
      title: "German checkout",
      createdAt: "2026-09-05T10:00:00Z",
      operations,
    },
    creator: { id: "agent", kind: "agent" },
    reviewerId: options.status ? "reviewer" : null,
    reviewedAt: options.status ? "2026-09-05T11:00:00Z" : null,
    appliedAt: options.status === "APPLIED" ? "2026-09-05T12:00:00Z" : null,
    failureCode: null,
    ...(options.status === "APPLIED"
      ? {
          receipt: {
            branch: `patchctl/l10n/${id}`,
            commitSha: "c".repeat(40),
            prUrl: "https://github.com/example/app/pull/1",
          },
        }
      : {}),
    events: [
      {
        event: "PATCH_SUBMITTED",
        actor: { id: "agent", kind: "agent" },
        timestamp: "2026-09-05T10:00:00Z",
      },
    ],
  };
  await page.addInitScript(() =>
    localStorage.setItem("accessToken", "test-session"),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        userId: "reviewer",
        email: "reviewer@example.test",
        activeTenantId: "tenant",
        memberships: [],
      },
    }),
  );
  await page.route("**/api/patchctl/me", (route) =>
    route.fulfill({
      json: {
        id: "reviewer",
        ownerUserId: "reviewer",
        tenantId: "tenant",
        kind: options.agent ? "agent" : "human",
        permissions: ["read", "review", "apply"],
        connectionIds: null,
      },
    }),
  );
  let status = options.status ?? "SUBMITTED";
  await page.route(`**/api/patchctl/local-patches/${id}`, (route) =>
    route.fulfill({ json: { ...patch, status } }),
  );
  await page.route(`**/api/patchctl/local-patches/${id}/decision`, (route) => {
    status = "APPROVED";
    return route.fulfill({
      json: {
        ...patch,
        status,
        reviewerId: "reviewer",
      },
    });
  });
  await page.goto(`/patches/${id}`);
}

test("compares translations and filters by locale, namespace, status, and errors", async ({
  page,
}) => {
  await mockReview(page);
  await expect(page.getByTestId("locale-summary").first()).toContainText(
    "de: 1 missing · 1 stale",
  );
  await expect(page.getByTestId("localization-diff")).toHaveCount(3);
  await expect(page.getByTestId("localization-diff").first()).toContainText(
    "Cancel",
  );
  await expect(page.getByTestId("localization-diff").first()).toContainText(
    "Missing (no value)",
  );
  await expect(page.getByTestId("localization-diff").first()).toContainText(
    "Abbrechen",
  );
  await page.getByLabel("Filter locale").selectOption("de");
  await expect(page.getByTestId("localization-diff")).toHaveCount(2);
  await page.getByLabel("Filter status").selectOption("stale");
  await expect(page.getByTestId("localization-diff")).toHaveCount(1);
  await expect(page.getByTestId("localization-diff")).toContainText(
    "checkout.pay",
  );
  await page.getByLabel("Filter namespace").selectOption("profile");
  await expect(page.getByText("No entries match these filters.")).toBeVisible();
  await page.getByLabel("Filter locale").selectOption("");
  await page.getByLabel("Filter status").selectOption("");
  await page.getByLabel("Filter namespace").selectOption("");
  await page.getByLabel("Validation errors only").check();
  await expect(page.getByText("No entries match these filters.")).toBeVisible();
  await page.getByLabel("Validation errors only").uncheck();
  await page.screenshot({
    path: "./.patchctl-results/localization/review.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "./.patchctl-results/localization/review-mobile.png",
    fullPage: true,
  });
});

test("approves the exact revision after human review", async ({ page }) => {
  await mockReview(page);
  const decision = page.waitForRequest((request) =>
    request.url().endsWith(`/${id}/decision`),
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  expect((await decision).postDataJSON()).toEqual({
    revision,
    decision: "APPROVED",
  });
  await expect(page.getByTestId("patch-state")).toHaveText("APPROVED");
});

test("agent credentials cannot approve even with claimed review permission", async ({
  page,
}) => {
  await mockReview(page, { agent: true });
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(
    page.getByText(/Human reviewer access is required/),
  ).toBeVisible();
});

test("validation errors remain visible and block approval", async ({
  page,
}) => {
  await mockReview(page, { invalid: true });
  await expect(
    page.getByRole("alert").filter({ hasText: "INVALID_SOURCE_REVISION" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();
  await page.getByLabel("Validation errors only").check();
  await expect(page.getByTestId("localization-diff")).toHaveCount(1);
});

test("shows the applied Git commit and pull request receipt", async ({
  page,
}) => {
  await mockReview(page, { status: "APPLIED" });
  await expect(page.getByTestId("patch-state")).toHaveText("APPLIED");
  await expect(page.getByText(`Commit ${"c".repeat(40)}`)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Pull request" }),
  ).toHaveAttribute("href", "https://github.com/example/app/pull/1");
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.screenshot({
    path: "./.patchctl-results/localization/applied-receipt.png",
    fullPage: true,
  });
});
