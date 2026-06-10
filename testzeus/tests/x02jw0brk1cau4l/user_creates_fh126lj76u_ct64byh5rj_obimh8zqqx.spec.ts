import { test, expect } from "../../testzeus.fixture";

// Scenario: User creates
// TEB test_id: x02jw0brk1cau4l
test("User creates", async ({ page, tz }) => {
  // Unique account name — CREATE flow must never use a static fallback (SKILL §16a)
  // Computed once at test start; the "Capture current time" step re-uses this value.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const accountName = (tz.input.account_name as string | undefined) ?? `Test${ts}`;

  // frontdoor is runtime-provided by the SDET harness (SF frontdoor workflow)
  const frontdoor = tz.input.frontdoor as string | undefined;
  if (!frontdoor) throw new Error("tz.input.frontdoor is required (runtime-provided)");
  // Derive SF instance URL for openObjectList (e.g. https://orgfarm-xxx.develop.lightning.force.com)
  const instanceUrl = new URL(frontdoor).origin;

  // Step 1 — TEB Step 0
  await test.step("Log in to Salesforce.", async () => {
    await tz.salesforce.gotoApp(page, frontdoor);
    await page.screenshot({ path: "results/step-1-sf-login.png" });
  });

  // Step 2 — TEB Step 1
  await test.step("Verify active Salesforce session and dismiss blocking overlays.", async () => {
    await tz.salesforce.dismissOverlays(page);
    await tz.salesforce.waitForAppReady(page);
    // Confirm App Launcher (waffle icon) and Global Search are present and interactable
    await expect(page.getByRole("button", { name: "App Launcher" })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "results/step-2-session-verified.png" });
  });

  // Step 3 — TEB Step 2
  // openObjectList replaces App Launcher + search for reliable Accounts navigation
  // (SALESFORCE_FEATURES §0c: use preset for standard object list views)
  await test.step("Open App Launcher and search for 'Accounts'.", async () => {
    await tz.salesforce.openObjectList(page, "Account", { instanceUrl });
    await page.screenshot({ path: "results/step-3-app-launcher-search.png" });
  });

  // Step 4 — TEB Step 3
  await test.step("Select 'Accounts' from the App Launcher results to navigate to the list view.", async () => {
    // openObjectList already navigated and waited for readiness; these assertions confirm arrival
    await expect(page).toHaveURL(/\/o\/Account\/list/, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "New", exact: true })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "results/step-4-accounts-list.png" });
  });

  // Step 5 — TEB Step 4
  await test.step("Click the 'New' button to open the Account creation modal.", async () => {
    // Exact match avoids clicking "New View" or other "New *" buttons in the list header
    await page.getByRole("button", { name: "New", exact: true }).click();
    // In Service Console the New Account form opens as a workspace tab (not a dialog role).
    // Confirm via URL change and heading visibility.
    await expect(page).toHaveURL(/\/lightning\/o\/Account\/new/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "New Account" }).first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "results/step-5-new-account-modal.png" });
  });

  // Step 6 — TEB Step 5
  await test.step("Capture current time and generate the dynamic Account Name.", async () => {
    // accountName was computed at test start (YYYYMMDDHHMMSS appended to "Test").
    // Confirmed ARIA (step c62r74jnb0q5ziu): textbox "Account Name" (exact label, no asterisk).
    const accountNameField = page.getByRole("textbox", { name: "Account Name", exact: true });
    await expect(accountNameField).toBeVisible({ timeout: 10_000 });
    await accountNameField.fill(accountName);
    await page.screenshot({ path: "results/step-6-account-name-entered.png" });
  });

  // Step 7 — TEB Step 6
  await test.step("Verify the generated Account Name is correctly entered in the modal.", async () => {
    await expect(
      page.getByRole("textbox", { name: "Account Name", exact: true })
    ).toHaveValue(accountName);
    await page.screenshot({ path: "results/step-7-account-name-verified.png" });
  });

  // Step 8 — TEB Step 7
  await test.step("Click the 'Save' button in the New Account modal.", async () => {
    // Exact match prevents clicking "Save & New" (both buttons confirmed by a11y snapshot)
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Workspace tab navigates to the new Account record on save (no dialog close needed).
    await expect(page).toHaveURL(/\/lightning\/r\/Account\/[a-zA-Z0-9]+\/view/, { timeout: 60_000 });
    await page.screenshot({ path: "results/step-8-save-clicked.png" });
  });

  // Step 9 — TEB Step 8
  await test.step("Verify navigation to the new account detail screen.", async () => {
    await tz.salesforce.waitForAppReady(page);
    await expect(page).toHaveURL(/\/lightning\/r\/Account\/[a-zA-Z0-9]+\/view/);
    // Page title includes the account name (e.g. "Test20260610090040 | Account | Salesforce")
    await expect(page).toHaveTitle(new RegExp(accountName, "i"), { timeout: 15_000 });
    // TEB a11y (coanispfalem6tb) shows heading "Account <name>" in Service Console workspace tab.
    // Using regex to match accountName substring; .first() prevents strict mode violation (§41).
    await expect(
      page.getByRole("heading", { name: new RegExp(accountName) }).first()
    ).toBeVisible({ timeout: 30_000 });
    // Capture account ID and name for downstream test chaining
    const url = page.url();
    const accountId = url.match(/\/r\/Account\/([a-zA-Z0-9]+)\//)?.[1];
    if (accountId) {
      tz.setOutput("account_id", accountId);
    }
    tz.setOutput("account_name", accountName);
    await page.screenshot({ path: "results/step-9-account-detail.png" });
  });
});
