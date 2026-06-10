import { test, expect } from "../../testzeus.fixture";

test("User creates", async ({ page, tz }) => {
  const runTag = Date.now();
  const accountName =
    (tz.input.account_name as string | undefined) ?? `Test${runTag}`;

  await test.step("Log in to Salesforce", async () => {
    const frontdoor = tz.input.frontdoor as string | undefined;
    if (!frontdoor) throw new Error("tz.input.frontdoor is required");
    await tz.salesforce.gotoApp(page, frontdoor);
    await page.screenshot({ path: "results/step-1-login.png" });
  });

  await test.step("Click on the App Launcher", async () => {
    await page.getByRole("button", { name: "App Launcher" }).click();
    await expect(
      page.getByRole("button", { name: "App Launcher" })
    ).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({ path: "results/step-2-app-launcher.png" });
  });

  await test.step("Search and select Accounts from App Launcher", async () => {
    await page.getByPlaceholder("Search apps and items...").fill("Accounts");
    await page
      .getByRole("option", { name: /^Accounts$/i })
      .first()
      .click();
    await tz.salesforce.waitForAppReady(page);
    await expect(
      page.getByRole("heading", { name: /Accounts/i }).first()
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "results/step-3-accounts.png" });
  });

  await test.step("Click on the 'New' button in the Accounts list view", async () => {
    await page.getByRole("button", { name: "New" }).click();
    await page.screenshot({ path: "results/step-4-new-account.png" });
  });

  await test.step("Dismiss guidance panel and calculate timestamp", async () => {
    await tz.salesforce.dismissOverlays(page);
    await page.screenshot({ path: "results/step-5-guidance-dismissed.png" });
  });

  await test.step("Enter Account Name with timestamp", async () => {
    await page
      .getByLabel("Account Name", { exact: true })
      .fill(accountName);
    await page.screenshot({ path: "results/step-6-account-name.png" });
  });

  await test.step("Click on the 'Save' button", async () => {
    const modal = page.getByRole("dialog", { name: /new account/i });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(modal).toBeHidden({ timeout: 60_000 });
    await page.screenshot({ path: "results/step-7-save.png" });
  });

  await test.step("Verify successful account creation and navigation", async () => {
    await expect(page).toHaveURL(
      /\/lightning\/r\/Account\/[a-zA-Z0-9]+\/view/,
      { timeout: 30_000 }
    );
    await expect(
      page.getByRole("heading", { name: accountName }).first()
    ).toBeVisible({ timeout: 30_000 });
    const result = await tz.salesforce.soql(
      `SELECT Id, Name FROM Account WHERE Name = '${accountName}' ORDER BY CreatedDate DESC LIMIT 1`
    );
    expect(result.totalSize).toBeGreaterThanOrEqual(1);
    tz.setOutput("account_name", accountName);
    tz.setOutput("account_id", result.records[0]?.Id ?? "");
    await page.screenshot({ path: "results/step-8-verify.png" });
  });
});
