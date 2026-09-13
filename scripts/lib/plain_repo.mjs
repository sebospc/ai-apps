/**
 * A git repository with no client code in it, and enough ordinary code around the change that
 * reading the whole checkout is not a strategy.
 *
 * Copied from `walk_skill.mjs` rather than imported: that file runs a walk on import and belongs to
 * another line of work. The two are allowed to drift; if they do, the scored set is the one that
 * has to keep working, because it is the one a budget is read from.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A throwaway repository holding `files` as `{ path: { before, after } }`: the `before` half is
 * committed, the `after` half is left uncommitted, so `git diff` is the change under review.
 */
export function buildPlainRepo(prefix, files) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@acme.com");
  git("config", "user.name", "Score");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content.before);
  }
  git("add", ".");
  git("commit", "-q", "-m", "baseline");
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content.after);
  }
  return repo;
}

/** A file that is the same before and after, which is every file a case plants evidence in. */
export function unchanged(source) {
  return { before: source, after: source };
}

/**
 * Ordinary code, in the quantity a checkout has it.
 *
 * A three-file repository is read whole with a `find` and four `cat`s, and a case measured that way
 * measures nothing — `walk_skill.mjs` threw away two fixtures to learn it. The filler is dull on
 * purpose: nothing in it is a defect, so anything a review reports about it is noise.
 */
export function ordinaryCode() {
  const areas = [
    ["core/src/com/acme/core/order", "com.acme.core.order", ["OrderEntryPopulator", "OrderService", "OrderDao", "OrderStatusStrategy", "OrderCodeGenerator"]],
    ["core/src/com/acme/core/customer", "com.acme.core.customer", ["CustomerAccountService", "CustomerDao", "CustomerNamePopulator", "CustomerGroupStrategy"]],
    ["core/src/com/acme/core/product", "com.acme.core.product", ["ProductVariantService", "ProductDao", "ProductUrlResolver", "ProductFeaturePopulator"]],
    ["core/src/com/acme/core/pricing", "com.acme.core.pricing", ["PriceRowService", "TaxValueConverter", "DiscountRowDao", "NetPriceStrategy"]],
    ["core/src/com/acme/core/stock", "com.acme.core.stock", ["StockLevelService", "WarehouseSelector", "StockLevelDao"]],
    ["facades/src/com/acme/facades/cart", "com.acme.facades.cart", ["CartFacadeImpl", "CartEntryPopulator", "CartValidator", "CartModificationConverter"]],
    ["facades/src/com/acme/facades/customer", "com.acme.facades.customer", ["CustomerFacadeImpl", "AddressPopulator", "RegisterDataValidator"]],
    ["facades/src/com/acme/facades/product", "com.acme.facades.product", ["ProductFacadeImpl", "ProductDataPopulator", "ImageFormatMapping"]],
    ["b2bstorefront/src/com/acme/b2b/checkout", "com.acme.b2b.checkout", ["CheckoutStepController", "PlaceOrderController", "DeliveryAddressForm", "PaymentDetailsForm"]],
    ["b2bstorefront/src/com/acme/b2b/cart", "com.acme.b2b.cart", ["CartPageController", "CartEntryForm", "SavedCartController"]],
  ];
  const files = {};
  for (const [directory, pkg, names] of areas) {
    for (const name of names) {
      const source = `package ${pkg};\n\npublic class Acme${name} {\n\n  public String describe() {\n    return "${name}";\n  }\n}\n`;
      files[`${directory}/Acme${name}.java`] = unchanged(source);
    }
  }
  return files;
}

/**
 * A second storefront extension, so "the same block exists in the other storefront" is a thing the
 * repository can actually be true about. Without it the parallel-implementation case is a search
 * for a directory that is not there.
 */
export function secondStorefront() {
  const areas = [
    ["b2cstorefront/src/com/acme/b2c/checkout", "com.acme.b2c.checkout", ["StoreCheckoutStepController", "StorePlaceOrderController", "StoreAddressForm"]],
    ["b2cstorefront/src/com/acme/b2c/cart", "com.acme.b2c.cart", ["StoreCartPageController", "StoreCartEntryForm"]],
    ["b2cstorefront/src/com/acme/b2c/account", "com.acme.b2c.account", ["StoreAccountController", "StoreProfileForm"]],
  ];
  const files = {};
  for (const [directory, pkg, names] of areas) {
    for (const name of names) {
      const source = `package ${pkg};\n\npublic class ${name} {\n\n  public String describe() {\n    return "${name}";\n  }\n}\n`;
      files[`${directory}/${name}.java`] = unchanged(source);
    }
  }
  return files;
}
