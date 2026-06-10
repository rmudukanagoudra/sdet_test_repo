import { test, expect } from "../../testzeus.fixture";

test("User creates", async ({ page, tz }) => {
  // Unique account name — CREATE flow must never rely on a static fallback (SKILL §16a)
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const accountName = (tz.input.account_name as string | undefined) ?? `Test${timestamp}`;

  await test.step("Log in to Salesforce.", async () => {
    const frontdoor = tz.input.frontdoor as string | undefined;
    if (!frontdoor) throw new Error("tz.input.frontdoor is required (runtime-provided)");
    await tz.salesforce.gotoApp(page, frontdoor);
    await page.screenshot({ path: "results/step-1-sf-login.png" });
  });

  await test.step("Verify active Salesforce session and dismiss blocking overlays.", async () => {
    await tz.salesforce.waitForAppReady(page);
    await tz.salesforce.dismissOverlays(page);
    await page.screenshot({ path: "results/step-2-session-verified.png" });
  });

  await test.step("Open App Launcher and search for 'Accounts'.", async () => {
    await page.getByRole("button", { name: "App Launcher" }).click();
    const appLauncherDialog = page.getByRole("dialog", { name: "App Launcher" });
    await expect(appLauncherDialog).toBeVisible({ timeout: 15_000 });
    // The App Launcher search combobox is the only combobox inside the dialog
    const searchBox = appLauncherDialog.getByRole("combobox").first();
    await searchBox.fill("Accounts");
    await page.screenshot({ path: "results/step-3-app-launcher-search.png" });
  });

  await test.step("Select 'Accounts' from the App Launcher results to navigate to the list view.", async () => {
    const appLauncherDialog = page.getByRole("dialog", { name: "App Launcher" });
    const accountsOption = appLauncherDialog.getByRole("option", { name: /^Accounts$/i }).first();
    await expect(accountsOption).toBeVisible({ timeout: 10_000 });
    await accountsOption.click();
    await tz.salesforce.waitForAppReady(page);
    await expect(page).toHaveURL(/\/o\/Account\/list/, { timeout: 30_000 });
    await page.screenshot({ path: "results/step-4-accounts-list.png" });
  });

  await test.step("Click the 'New' button to open the Account creation modal.", async () => {
    await page.getByRole("button", { name: "New", exact: true }).first().click();
    // The New Account form opens as a full page (Lightning Console tabpanel), not a dialog
    await expect(page.getByRole("heading", { name: "New Account" }).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: "results/step-5-new-account-form.png" });
  });

  await test.step("Capture current time and generate the dynamic Account Name.", async () => {
    // accountName was generated at test scope; fill it into the Account Name field
    const accountNameField = page.getByRole("textbox", { name: "Account Name", exact: true });
    await expect(accountNameField).toBeVisible({ timeout: 10_000 });
    await accountNameField.fill(accountName);
    await page.screenshot({ path: "results/step-6-account-name-entered.png" });
  });

  await test.step("Verify the generated Account Name is correctly entered in the modal.", async () => {
    const accountNameField = page.getByRole("textbox", { name: "Account Name", exact: true });
    await expect(accountNameField).toHaveValue(accountName);
    await page.screenshot({ path: "results/step-7-account-name-verified.png" });
  });

  await test.step("Click the 'Save' button in the New Account modal.", async () => {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Saving navigates to the newly created Account record page
    await expect(page).toHaveURL(/\/lightning\/r\/Account\/[a-zA-Z0-9]+\/view/, { timeout: 60_000 });
    await page.screenshot({ path: "results/step-8-save-clicked.png" });
  });

  await test.step("Verify navigation to the new account detail screen.", async () => {
    await tz.salesforce.waitForAppReady(page);
    await expect(page).toHaveURL(/\/lightning\/r\/Account\/[a-zA-Z0-9]+\/view/);
    await expect(page).toHaveTitle(new RegExp(accountName), { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: accountName }).first()).toBeVisible({
      timeout: 15_000,
    });
    // Capture account ID from URL and save outputs for downstream chaining
    const url = page.url();
    const accountId = url.match(/\/r\/Account\/([a-zA-Z0-9]+)\//)?.[1];
    if (accountId) {
      tz.setOutput("account_id", accountId);
    }
    tz.setOutput("account_name", accountName);
    await page.screenshot({ path: "results/step-9-account-detail.png" });
  });
});
