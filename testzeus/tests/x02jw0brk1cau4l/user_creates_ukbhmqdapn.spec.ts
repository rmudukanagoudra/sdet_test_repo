import { test, expect } from "../../testzeus.fixture";

// Scenario: User creates
// TEB test_id: x02jw0brk1cau4l
test("User creates", async ({ page, tz }) => {
  // Unique account name — CREATE flow must never use a static fallback (SKILL §16a)
  // Computed once at test start; all steps re-use this value.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const accountName = (tz.input.account_name as string | undefined) ?? `Test ${ts}`;
  // Escape any regex-special chars in accountName for use in assertions
  const accountNameRe = new RegExp(accountName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  // frontdoor is runtime-provided by the SDET harness (SF frontdoor workflow)
  const frontdoor = tz.input.frontdoor as string | undefined;
  if (!frontdoor) throw new Error("tz.input.frontdoor is required (runtime-provided)");

  // instanceUrl via harness helper; falls back to frontdoor origin when helper returns null
  // (SALESFORCE_FEATURES §0c — use resolveSalesforceInstanceUrl for openObjectList)
  const instanceUrl = tz.resolveSalesforceInstanceUrl() ?? new URL(frontdoor).origin;

  // Step 1 — TEB Step 0: Log in to Salesforce.
  await test.step("Log in to Salesforce.", async () => {
    await tz.salesforce.gotoApp(page, frontdoor);
    await page.screenshot({ path: "results/step-1-sf-login.png" });
  });

  // Step 2 — TEB Step 1: Navigate to Accounts via App Launcher.
  // SALESFORCE_FEATURES §0c: openObjectList navigates directly to /lightning/o/Account/list
  // and is more reliable than App Launcher + Enter (which can land on splash chrome).
  await test.step("Navigate to Accounts via App Launcher.", async () => {
    await tz.salesforce.openObjectList(page, "Account", { instanceUrl });
    await expect(page).toHaveURL(/\/o\/Account\/list/, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: "results/step-2-accounts-list.png" });
  });

  // Step 3 — TEB Step 2: Click the 'New' button to open the Account creation form.
  // a11y (gi558k4agh8tzsk) confirms: role="dialog", name="New Account" appears after click.
  // exact: true prevents clicking "New View" or other "New *" buttons in the list header.
  await test.step("Click the 'New' button to open the Account creation form.", async () => {
    await page.getByRole("button", { name: "New", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /new account/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: "results/step-3-new-account-form.png" });
  });

  // Step 4 — TEB Step 3: Enter 'Test' with current time into the Account Name field.
  // a11y (gi558k4agh8tzsk) confirms: role="textbox", name="Account Name" inside dialog.
  await test.step("Enter 'Test' with current time into the Account Name field.", async () => {
    const dialog = page.getByRole("dialog", { name: /new account/i });
    const accountNameField = dialog.getByRole("textbox", { name: "Account Name" });
    await expect(accountNameField).toBeVisible({ timeout: 10_000 });
    await accountNameField.fill(accountName);
    await expect(accountNameField).toHaveValue(accountName);
    await page.screenshot({ path: "results/step-4-account-name-entered.png" });
  });

  // Step 5 — TEB Step 4: Click the 'Save' button to create the account.
  // SKILL §24: wait for modal to close BEFORE asserting the record page — Lightning modal
  // animations keep the dialog DOM present after the URL changes to the new record view.
  // exact: true prevents clicking "Save & New" (both buttons confirmed by TEB step 2 hercules_log).
  await test.step("Click the 'Save' button to create the account.", async () => {
    const modal = page.getByRole("dialog", { name: /new account/i });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(modal).toBeHidden({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/r\/Account\/[a-zA-Z0-9]+\/view/, { timeout: 60_000 });
    await page.screenshot({ path: "results/step-5-save-clicked.png" });
  });

  // Step 6 — TEB Step 5: Verify navigation to the account detail screen and validate record creation.
  // a11y (b9qz4cvnm7dx797) confirms: heading "Account Test 12:53" (level 1) on record page.
  // The heading text has "Account " prefix + accountName; regex matches the substring.
  // .first() prevents strict mode violation — SF pages render duplicate hidden headings.
  await test.step("Verify navigation to the account detail screen and validate record creation.", async () => {
    await tz.salesforce.waitForAppReady(page);
    await expect(page).toHaveURL(/\/r\/Account\/[a-zA-Z0-9]+\/view/);
    await expect(
      page.getByRole("heading", { name: accountNameRe }).first()
    ).toBeVisible({ timeout: 30_000 });
    // Page title format: "Test 12:53 | Account | Salesforce" (TEB hercules_log step 5)
    await expect(page).toHaveTitle(accountNameRe, { timeout: 15_000 });
    // Capture account ID and name for downstream test chaining
    const url = page.url();
    const accountId = url.match(/\/r\/Account\/([a-zA-Z0-9]+)\//)?.[1];
    if (accountId) {
      tz.setOutput("account_id", accountId);
    }
    tz.setOutput("account_name", accountName);
    await page.screenshot({ path: "results/step-6-account-detail.png" });
  });
});
