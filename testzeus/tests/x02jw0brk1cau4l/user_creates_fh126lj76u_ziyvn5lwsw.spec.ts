import { test, expect } from "../../testzeus.fixture";

// Scenario: User creates
// Source TEB test_id: x02jw0brk1cau4l
test("User creates", async ({ page, tz }) => {
  // CREATE flow: account name must be unique per run (SKILL §16a — static fallback collides on re-run)
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const accountName = (tz.input.account_name as string | undefined) ?? `Test${ts}`;

  await test.step("Log in to Salesforce.", async () => {
    const frontdoor = tz.input.frontdoor as string | undefined;
    if (!frontdoor) throw new Error("tz.input.frontdoor is required (runtime-provided)");
    await tz.salesforce.gotoApp(page, frontdoor);
    await page.screenshot({ path: "results/step-1-sf-login.png" });
  });

  await test.step("Verify active Salesforce session and dismiss blocking overlays.", async () => {
    await tz.salesforce.waitForAppReady(page);
    await tz.salesforce.dismissOverlays(page);
    // App Launcher button must be present and interactable to confirm the session is active
    await expect(page.getByRole("button", { name: "App Launcher" })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "results/step-2-sf-verified.png" });
  });

  await test.step("Open App Launcher and search for 'Accounts'.", async () => {
    await page.getByRole("button", { name: "App Launcher" }).click();
    // App Launcher search — use placeholder to avoid relying on dialog ARIA which may not render
    // in Service Console. The placeholder "Search apps and items..." is stable across org types.
    const searchInput = page.getByPlaceholder("Search apps and items...");
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill("Accounts");
    // Wait for Accounts to surface in results before proceeding
    await expect(
      page.getByRole("option", { name: "Accounts", exact: true })
        .or(page.getByRole("link", { name: "Accounts", exact: true }))
        .first()
    ).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: "results/step-3-app-launcher-search.png" });
  });

  await test.step("Select 'Accounts' from the App Launcher results to navigate to the list view.", async () => {
    // App Launcher results and the Service Console nav bar both expose an "Accounts" link.
    // Hercules navigated via the nav bar link (confirmed by TEB md=83 selector).
    const accountsLink = page.getByRole("option", { name: "Accounts", exact: true })
      .or(page.getByRole("link", { name: "Accounts", exact: true }))
      .first();
    await accountsLink.click();
    await tz.salesforce.waitForAppReady(page);
    await expect(page).toHaveURL(/\/o\/Account\/list/, { timeout: 30_000 });
    await page.screenshot({ path: "results/step-4-accounts-list.png" });
  });

  await test.step("Click the 'New' button to open the Account creation modal.", async () => {
    await page.getByRole("button", { name: "New", exact: true }).first().click();
    // In Service Console, the New Account form opens as a workspace tab, not a dialog.
    // Verify via the tab label AND the Account Name field being present.
    await expect(
      page.getByRole("tab", { name: /New Account/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("textbox", { name: "Account Name", exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "results/step-5-new-account-form.png" });
  });

  await test.step("Capture current time and generate the dynamic Account Name.", async () => {
    // accountName was generated at test scope (unique per run). Dismiss any overlays, then fill.
    await tz.salesforce.dismissOverlays(page);
    const accountNameField = page.getByRole("textbox", { name: "Account Name", exact: true });
    await accountNameField.fill(accountName);
    await page.screenshot({ path: "results/step-6-account-name-entered.png" });
  });

  await test.step("Verify the generated Account Name is correctly entered in the modal.", async () => {
    const accountNameField = page.getByRole("textbox", { name: "Account Name", exact: true });
    await expect(accountNameField).toHaveValue(accountName);
    await page.screenshot({ path: "results/step-7-account-name-verified.png" });
  });

  await test.step("Click the 'Save' button in the New Account modal.", async () => {
    // Use exact: true to avoid matching "Save & New" button which is also present.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // After save, the Service Console tab closes and navigates to the new record view.
    await expect(page).toHaveURL(/\/lightning\/r\/Account\/[a-zA-Z0-9]+\/view/, { timeout: 60_000 });
    await page.screenshot({ path: "results/step-8-save-clicked.png" });
  });

  await test.step("Verify navigation to the new account detail screen.", async () => {
    await tz.salesforce.waitForAppReady(page);
    await expect(page).toHaveURL(/\/lightning\/r\/Account\/[a-zA-Z0-9]+\/view/);
    // Confirm the record detail page displays the newly created account's name
    await expect(
      page.getByRole("heading", { name: accountName }).first()
    ).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveTitle(new RegExp(accountName), { timeout: 15_000 });
    // Capture output variables for downstream test chaining
    const url = page.url();
    const accountId = url.match(/\/r\/Account\/([a-zA-Z0-9]+)\//)?.[1];
    if (accountId) tz.setOutput("account_id", accountId);
    tz.setOutput("account_name", accountName);
    await page.screenshot({ path: "results/step-9-account-detail.png" });
  });
});
