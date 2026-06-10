# TestZeus SDET Suite

This directory is **managed by TestZeus**. The `.spec.ts` files under `tests/` are
generated automatically from your manual test runs and committed here as the source of
truth. The TestZeus runner injects `runtime-context.json` and `fixtures/` at execution
time (test data, environment, and uploadable files), so specs never hardcode transient
values or local paths.

Specs bind to the runtime via the `tz` fixture:

```ts
import { test, expect } from "../../testzeus.fixture";

test("checkout", async ({ page, tz }) => {
  await page.goto(tz.environment.web.base_url as string);
  await page.getByLabel("Email").fill(tz.testdata.creds.email as string);
  await page.getByLabel("Password").fill(tz.testdata.creds.password as string); // secret, injected at run time
  tz.setOutput("order_id", await page.getByTestId("order-id").innerText());
});
```

You may edit specs directly — TestZeus reads this repo back as the canonical automation.
The harness files (`package.json`, `playwright.config.ts`, `tsconfig.json`,
`testzeus.fixture.ts`, `tz-runtime.ts`) are seeded once and not overwritten. Secrets are
injected via a local-only `fixtures/.tz-secrets.json` overlay that is gitignored and
never uploaded as an artifact.
