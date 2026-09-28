import { expect, test } from "@playwright/test";

const id = "6e753913-798c-4af2-b97b-0c7f89ce7d2a";

test("submitted localization Patch cannot be approved before translation review", async ({
  page,
}) => {
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
        kind: "human",
        permissions: ["read", "review", "apply"],
        connectionIds: null,
      },
    }),
  );
  await page.route(`**/api/patchctl/local-patches/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        tenantId: "tenant",
        revision: "a".repeat(64),
        status: "SUBMITTED",
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
          operations: [
            {
              id: "798c0375-5fb1-46f4-85d6-8c25442e568d",
              key: "checkout.cancel",
              sourceLocale: "en",
              sourceText: "Cancel",
              sourceRevision: "c".repeat(64),
              sourcePath: "locales/en.json",
              targetLocale: "de",
              targetBefore: null,
              targetAfter: "Abbrechen",
              targetPath: "locales/de.json",
              targetBlobSha: "d".repeat(40),
            },
          ],
        },
        creator: { id: "agent", kind: "agent" },
        reviewerId: null,
        reviewedAt: null,
        appliedAt: null,
        failureCode: null,
        events: [
          {
            event: "PATCH_SUBMITTED",
            actor: { id: "agent", kind: "agent" },
            timestamp: "2026-09-05T10:00:00Z",
          },
        ],
      },
    }),
  );
  await page.goto(`/patches/${id}`);
  await expect(
    page.getByRole("status").filter({ hasText: "translation review view" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.screenshot({
    path: "./.patchctl-results/localization/review.png",
    fullPage: true,
  });
});
