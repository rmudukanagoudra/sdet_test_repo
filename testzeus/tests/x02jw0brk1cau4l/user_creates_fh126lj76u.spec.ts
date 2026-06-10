import { test, expect } from "../../testzeus.fixture";

test("User creates", async ({ page, tz }) => {
  // Unique account name — CREATE flow must never rely on a static fallback (SKILL §16a)
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const accountName = (tz.input.account_name as string | undefined) ?? `Test${timestamp}`;

  await test.step("Log in to Salesforce", async () => {
    const frontdoor = tz.input.frontdoor as string | undefined;
    if (!frontdoor) throw new Error("tz.input.frontdoor is required (runtime-provided)");
    await tz.salesforce.gotoApp(page, frontdoor);
    await page.screenshot({ path: "results/step-1-sf-login.png" });
  });

  await test.step("Click on the App Launcher", async () => {
    await page.getByRole("button", { name: "App Launcher" }).click();
    await expect(page.getByRole("dialog", { name: "App Launcher" })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: "results/step-2-app-launcher.png" });
  });

  await test.step("Search and select Accounts from App Launcher", async () => {
    const appLauncherDialog = page.getByRole("dialog", { name: "App Launcher" });
    const searchBox = appLauncherDialog.getByRole("combobox", { name: "Search apps and items..." });
    await searchBox.fill("Accounts");
    // Search results surface Accounts as an option in the results listbox
    const accountsResult = appLauncherDialog.getByRole("option", { name: /^Accounts$/i }).first();
    await expect(accountsResult).toBeVisible({ timeout: 10_000 });
    await accountsResult.click();
    await tz.salesforce.waitForAppReady(page);
    await expect(page).toHaveURL(/\/o\/Account\/list/, { timeout: 30_000 });
    await page.screenshot({ path: "results/step-3-accounts-list.png" });
  });

  await test.step("Click on the 'New' button in the Accounts list view", async () => {
    await page.getByRole("button", { name: "New", exact: true }).first().click();
    await expect(
      page.getByRole("heading", { name: "New Account", exact: true }).first()
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "results/step-4-new-account-modal.png" });
  });

  await test.step("Dismiss guidance panel and calculate timestamp", async () => {
    // Dismiss any guidance overlays (e.g. "Just so you know…" panels) before interacting with the form
    await tz.salesforce.dismissOverlays(page);
    await page.screenshot({ path: "results/step-5-timestamp-calculated.png" });
  });

  await test.step("Enter Account Name with timestamp", async () => {
    const accountNameField = page.getByRole("textbox", { name: "Account Name", exact: true });
    await accountNameField.fill(accountName);
    await expect(accountNameField).toHaveValue(accountName);
    await page.screenshot({ path: "results/step-6-account-name-entered.png" });
  });

  await test.step("Click on the 'Save' button", async () => {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Wait for navigation to the newly created Account record detail page
    await expect(page).toHaveURL(/\/lightning\/r\/Account\/[a-zA-Z0-9]+\/view/, { timeout: 60_000 });
    await page.screenshot({ path: "results/step-7-save-clicked.png" });
  });

  await test.step("Verify successful account creation and navigation", async () => {
    await tz.salesforce.waitForAppReady(page);
    await expect(page).toHaveURL(/\/lightning\/r\/Account\/[a-zA-Z0-9]+\/view/);
    // Verify record page title includes the new account name
    await expect(page).toHaveTitle(new RegExp(accountName), { timeout: 15_000 });
    // Verify the account name is visible as a heading on the detail page
    await expect(
      page.getByRole("heading", { name: accountName }).first()
    ).toBeVisible({ timeout: 15_000 });
    // Capture account ID from URL for downstream test chaining
    const url = page.url();
    const accountId = url.match(/\/r\/Account\/([a-zA-Z0-9]+)\//)?.[1];
    if (accountId) {
      tz.setOutput("account_id", accountId);
    }
    tz.setOutput("account_name", accountName);
    await page.screenshot({ path: "results/step-8-account-detail.png" });
  });
});
