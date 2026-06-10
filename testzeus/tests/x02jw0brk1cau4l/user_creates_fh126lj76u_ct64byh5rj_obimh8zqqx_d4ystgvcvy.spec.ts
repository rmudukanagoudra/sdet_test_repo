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

  // frontdoor is runtime-provided by the SDET harness (SF frontdoor workflow)
  const frontdoor = tz.input.frontdoor as string | undefined;
  if (!frontdoor) throw new Error("tz.input.frontdoor is required (runtime-provided)");
  const instanceUrl = new URL(frontdoor).origin;

  // Step 1 — TEB Step 0
  await test.step("Log in to Salesforce.", async () => {
    await tz.salesforce.gotoApp(page, frontdoor);
    await page.screenshot({ path: "results/step-1-sf-login.png" });
  });

  // Step 2 — TEB Step 1
  // SALESFORCE_FEATURES §0c: use openObjectList for reliable Accounts list-view navigation
  await test.step("Navigate to Accounts via App Launcher.", async () => {
    await tz.salesforce.openObjectList(page, "Account", { instanceUrl });
    await expect(page).toHaveURL(/\/o\/Account\/list/, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: "results/step-2-accounts-list.png" });
  });

  // Step 3 — TEB Step 2
  await test.step("Click the 'New' button to open the Account creation form.", async () => {
    // Exact match avoids clicking "New View" or other "New *" buttons in the list header
    await page.getByRole("button", { name: "New", exact: true }).click();
    // TEB a11y (gi558k4agh8tzsk) confirms New Account opens as role="dialog" name="New Account"
    // (not a workspace tab — the ARIA snapshot is authoritative)
    await expect(page.getByRole("dialog", { name: /new account/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: "results/step-3-new-account-form.png" });
  });

  // Step 4 — TEB Step 3
  await test.step("Enter 'Test' with current time into the Account Name field.", async () => {
    const dialog = page.getByRole("dialog", { name: /new account/i });
    // TEB a11y (gi558k4agh8tzsk): role="textbox" name="Account Name" is inside the dialog
    const accountNameField = dialog.getByRole("textbox", { name: "Account Name" });
    await expect(accountNameField).toBeVisible({ timeout: 10_000 });
    await accountNameField.fill(accountName);
    await expect(accountNameField).toHaveValue(accountName);
    await page.screenshot({ path: "results/step-4-account-name-entered.png" });
  });

  // Step 5 — TEB Step 4
  await test.step("Click the 'Save' button to create the account.", async () => {
    const modal = page.getByRole("dialog", { name: /new account/i });
    // Exact match prevents clicking "Save & New" (both buttons confirmed by TEB step 2 hercules_log)
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // SKILL §24: wait for modal to close BEFORE asserting the record page — Lightning modal
    // animations keep the dialog DOM present after the URL changes to the new record view.
    // Use dialog ONLY — never .or(dialog, heading) as heading is inside dialog → strict mode violation.
    await expect(modal).toBeHidden({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/r\/Account\/[a-zA-Z0-9]+\/view/, { timeout: 60_000 });
    await page.screenshot({ path: "results/step-5-save-clicked.png" });
  });

  // Step 6 — TEB Step 5
  await test.step("Verify navigation to the account detail screen and validate record creation.", async () => {
    await tz.salesforce.waitForAppReady(page);
    await expect(page).toHaveURL(/\/r\/Account\/[a-zA-Z0-9]+\/view/);
    // TEB a11y (zic1qaeb7vnm10g) shows heading "Account Test 12:53" (level 1) — contains accountName
    // Use .first() to prevent strict mode violation (SF pages have duplicate hidden headings, SKILL §12)
    await expect(
      page.getByRole("heading", { name: new RegExp(accountName) }).first()
    ).toBeVisible({ timeout: 30_000 });
    // Page title includes accountName (e.g. "Test 12:53 | Account | Salesforce")
    await expect(page).toHaveTitle(new RegExp(accountName, "i"), { timeout: 15_000 });
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
