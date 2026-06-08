import { chromium } from "playwright";

const OUT = process.env.SHOT_DIR;
const BASE = "http://localhost:3000/book/confirmation/v2?billId=";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 900, height: 1100 },
  deviceScaleFactor: 2,
});
await ctx.addInitScript(() => {
  try {
    for (const id of ["TEST-MULTI", "TEST-MULTI2", "TEST-RACE", "TEST-ATTR"])
      sessionStorage.setItem(`notif_sent_${id}`, "1");
  } catch {}
});
const page = await ctx.newPage();

async function waitImages() {
  await page
    .evaluate(() =>
      Promise.all(
        Array.from(document.images).map((img) =>
          img.complete ? 0 : new Promise((r) => (img.onload = img.onerror = r)),
        ),
      ),
    )
    .catch(() => {});
}
async function shot(name) {
  await waitImages();
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log("shot", name);
}
async function load(id) {
  await page.goto(BASE + id, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(() => !document.body.innerText.includes("Confirming your booking"), {
      timeout: 45000,
    })
    .catch(() => console.log("  (still loading after 45s for", id, ")"));
  await page.waitForTimeout(2500);
}
async function back() {
  await page.getByText(/all bookings/i).click();
  await page.waitForTimeout(800);
}

await load("TEST-MULTI");
await shot("01-multi-hub");
await page
  .getByRole("button", { name: /racing/i })
  .first()
  .click();
await page.waitForTimeout(1000);
await shot("02-multi-racing");
await back();
await page
  .getByRole("button", { name: /gel blaster/i })
  .first()
  .click();
await page.waitForTimeout(1000);
await shot("03-multi-gel-blaster");
await back();
await page
  .getByRole("button", { name: /bowling/i })
  .first()
  .click();
await page.waitForTimeout(1000);
await shot("04-multi-bowling");

await load("TEST-MULTI2");
await shot("05-multi2-hub-no-racing");

await load("TEST-RACE");
await shot("06-racing-only");

await load("TEST-ATTR");
await shot("07-attraction-only");

await load("TEST-BOWL");
await shot("08-bowling-only");

await load("TEST-EXPRESS");
await shot("09-racing-express-lane");

await browser.close();
console.log("SHOTS_DONE");
