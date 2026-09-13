#!/usr/bin/env node
/**
 * How often would a guideline fire on ordinary code?
 *
 *   node scripts/guideline_probe.mjs <guideline-id> [--cases 6]
 *
 * A deterministic check ships with two fixtures: one where it fires and one of ordinary code where
 * it stays quiet. A guideline ships with nothing. It is prose handed to a model, so the only thing
 * that has ever measured one is rule health — which reports after developers have already been
 * annoyed by it. That is backwards, and it is why `no-scattered-condition` could be wrong about a
 * jQuery file for months without anything noticing.
 *
 * This runs a real review over a set of ordinary changes and counts how many come back citing the
 * guideline. A guideline that fires on most ordinary code is noise, and the number says so before
 * anybody ships it.
 *
 * Needs the API up. Uses `SMITH_CORPUS` when it points at a real checkout, because a guideline
 * measured against invented code is measured against code written by the same kind of model that
 * will review it. Without one it falls back to a built-in set and says so — a weaker reading, and
 * reported as weaker rather than quietly presented as the same thing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapProject, buildRepo } from "./lib/corpus_repo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugin", "bin", "smith");
const API = process.env.SMITH_API_URL ?? "http://localhost:8099";

/**
 * Ordinary SAP Commerce changes with nothing wrong in them.
 *
 * Every one is the kind of edit that lands in a sprint and should produce no finding at all. A
 * guideline that fires here is firing on a working day.
 */
const ORDINARY = [
  {
    path: "core/src/com/acme/core/service/impl/DefaultPriceRoundingService.java",
    before: `package com.acme.core.service.impl;

public class DefaultPriceRoundingService {
}
`,
    after: `package com.acme.core.service.impl;

import java.math.BigDecimal;
import java.math.RoundingMode;

public class DefaultPriceRoundingService {
  public BigDecimal round(final BigDecimal amount, final int scale) {
    return amount.setScale(scale, RoundingMode.HALF_UP);
  }
}
`,
  },
  {
    path: "core/src/com/acme/core/populator/OrderEntryTotalPopulator.java",
    before: `package com.acme.core.populator;

public class OrderEntryTotalPopulator {
}
`,
    after: `package com.acme.core.populator;

import de.hybris.platform.converters.Populator;

public class OrderEntryTotalPopulator {
  public void populate(final OrderEntrySource source, final OrderEntryData target) {
    if (source.getTotalPrice() != null) {
      target.setTotalPrice(source.getTotalPrice());
    }
  }
}
`,
  },
  {
    path: "core/resources/impex/acme-countries.impex",
    before: `$productCatalog=acmeProductCatalog
`,
    after: `$productCatalog=acmeProductCatalog

INSERT_UPDATE Country;isocode[unique=true];name[lang=en];active
;CO;Colombia;true
;MX;Mexico;true
`,
  },
  {
    path: "storefront/app/src/app/cart/cart-total.component.ts",
    before: `export class CartTotalComponent {
}
`,
    after: `import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'acme-cart-total',
  templateUrl: './cart-total.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CartTotalComponent {
  @Input() total = 0;
}
`,
  },
  {
    path: "core/resources/acme-core-items.xml",
    before: `<items>
</items>
`,
    after: `<items>
  <itemtypes>
    <itemtype code="AcmeGiftMessage" extends="GenericItem">
      <deployment table="AcmeGiftMessage" typecode="14501"/>
      <attributes>
        <attribute qualifier="text" type="java.lang.String">
          <persistence type="property"/>
        </attribute>
      </attributes>
    </itemtype>
  </itemtypes>
</items>
`,
  },
  {
    path: "core/src/com/acme/core/dao/impl/DefaultGiftMessageDao.java",
    before: `package com.acme.core.dao.impl;

public class DefaultGiftMessageDao {
}
`,
    after: `package com.acme.core.dao.impl;

import de.hybris.platform.servicelayer.search.FlexibleSearchService;
import de.hybris.platform.servicelayer.search.FlexibleSearchQuery;

public class DefaultGiftMessageDao {
  private FlexibleSearchService flexibleSearchService;

  public List<AcmeGiftMessageModel> findByOrder(final OrderModel order) {
    final FlexibleSearchQuery query = new FlexibleSearchQuery(
        "SELECT {pk} FROM {AcmeGiftMessage} WHERE {order} = ?order");
    query.addQueryParameter("order", order);
    return flexibleSearchService.<AcmeGiftMessageModel>search(query).getResult();
  }
}
`,
  },
];

/**
 * A change that must trip one specific guideline.
 *
 * The probe's whole output is a count of citations, so a probe that cannot read a citation prints a
 * clean zero and looks like good news — which is exactly the defect it shipped with. `--self-check`
 * runs this first: if the plumbing cannot see a guideline fire on a change built to fire it, no
 * other number from this tool means anything.
 */
const TRAP = {
  guideline: "items-xml-active-flag-unique-index",
  path: "core/resources/acme-core-items.xml",
  before: `<items>
</items>
`,
  after: `<items>
  <itemtypes>
    <itemtype code="AcmeLoyaltyCard" extends="GenericItem">
      <deployment table="AcmeLoyaltyCard" typecode="14620"/>
      <attributes>
        <attribute qualifier="cardNumber" type="java.lang.String">
          <persistence type="property"/>
        </attribute>
        <attribute qualifier="active" type="java.lang.Boolean">
          <persistence type="property"/>
          <defaultvalue>Boolean.TRUE</defaultvalue>
        </attribute>
      </attributes>
      <indexes>
        <index name="idx_acme_loyalty_card_number" unique="true">
          <key attribute="cardNumber"/>
        </index>
      </indexes>
    </itemtype>
  </itemtypes>
</items>
`,
};

function trapCase() {
  const repo = mkdtempSync(join(tmpdir(), "smith-guideline-trap-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@acme.com");
  git("config", "user.name", "Probe");
  mkdirSync(join(repo, dirname(TRAP.path)), { recursive: true });
  writeFileSync(join(repo, TRAP.path), TRAP.before);
  git("add", ".");
  git("commit", "-q", "-m", "baseline");
  writeFileSync(join(repo, TRAP.path), TRAP.after);
  return repo;
}

function plainCase(index) {
  const change = ORDINARY[index % ORDINARY.length];
  const repo = mkdtempSync(join(tmpdir(), "smith-guideline-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@acme.com");
  git("config", "user.name", "Probe");
  mkdirSync(join(repo, dirname(change.path)), { recursive: true });
  writeFileSync(join(repo, change.path), change.before);
  git("add", ".");
  git("commit", "-q", "-m", "baseline");
  writeFileSync(join(repo, change.path), change.after);
  return { repo, about: change.path };
}

/** One review, driven by a real agent through the plugin, exactly as a developer's would be. */
function review(repo, key) {
  const home = mkdtempSync(join(tmpdir(), "smith-guideline-home-"));
  const run = (args, input) => {
    try {
      return execFileSync("node", [PLUGIN, ...args], {
        cwd: repo,
        encoding: "utf8",
        input,
        env: { ...process.env, SMITH_HOME: home },
      });
    } catch (err) {
      if (err.stdout) return err.stdout;
      throw new Error(`smith ${args[0]} failed: ${err.stderr || err.message}`);
    }
  };
  try {
    run(["auth", "--url", API, "--key", key]);
    const plan = JSON.parse(run(["plan"]));
    if (plan.skipped) return { skipped: true, reason: plan.reason };

    const session = execFileSync(
      "claude",
      ["--plugin-dir", join(ROOT, "plugin"), "-p", "/smith-review my uncommitted changes",
       "--allowedTools", "Bash,Read,Glob,Grep", "--output-format", "stream-json", "--verbose"],
      { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SMITH_HOME: home } },
    );

    // The session runs its own `plan`, so its findings land on a review this function never created.
    // Reading back the one from the `plan` above returned the deterministic half and nothing else,
    // which made `fired` zero by construction and every reading taken with it worthless. The review
    // the session actually used is named in the `submit` it ran.
    const commands = session.split("\n").flatMap((line) => {
      try {
        const message = JSON.parse(line);
        if (message.type !== "assistant") return [];
        return (message.message?.content ?? [])
          .filter((block) => block.type === "tool_use")
          .map((block) => String(block.input?.command ?? ""));
      } catch {
        return [];
      }
    });
    const submitted = commands
      .map((command) => /\bsubmit\s+(\d+)/.exec(command)?.[1])
      .filter(Boolean)
      .at(-1);

    const offered = (plan.guidelines ?? []).map((g) => g.id);
    // No submit at all is a real outcome — the session reviewed and reported nothing — and it must
    // read as "no findings", never as a failure to measure.
    if (!submitted) return { offered, cited: [], submitted: false };

    const detail = JSON.parse(run(["review", submitted]));
    return {
      offered,
      cited: (detail.findings ?? []).map((f) => f.rule_id),
      submitted: true,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: node scripts/guideline_probe.mjs <guideline-id> [--cases N]");
    process.exit(1);
  }
  const flag = process.argv.indexOf("--cases");
  const wanted = flag === -1 ? ORDINARY.length : Number(process.argv[flag + 1]);

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`nothing is answering at ${API}. Start it with:\n  uv run uvicorn smith.main:app --port 8099`);
    process.exit(1);
  }

  const corpus = process.env.SMITH_CORPUS;
  const real = Boolean(corpus && existsSync(corpus));

  if (process.argv.includes("--self-check")) {
    const slug = `guideline-self-${Date.now().toString(36)}`;
    const key = bootstrapProject(slug, "lead@example.com", "walk-password-1");
    const repo = trapCase();
    try {
      const result = review(repo, key);
      const fired = (result.cited ?? []).includes(TRAP.guideline);
      console.log(`self-check · ${TRAP.guideline} on a change built to trip it`);
      console.log(`  offered=${(result.offered ?? []).includes(TRAP.guideline)} fired=${fired}`);
      console.log(
        fired
          ? "\nthe probe can see a citation. Its zeroes mean something."
          : "\nthe probe saw nothing on a change built to fire. Every zero it prints is worthless"
            + " until this passes — do not read another number from it.",
      );
      process.exit(fired ? 0 : 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
  console.log(`guideline ${id} · ${wanted} ordinary changes · ${real ? "corpus" : "built-in set, a weaker reading"}\n`);

  const slug = `guideline-${Date.now().toString(36)}`;
  const key = bootstrapProject(slug, "lead@example.com", "walk-password-1");

  let offeredCount = 0;
  let firedCount = 0;
  let skippedCount = 0;
  for (let i = 0; i < wanted; i += 1) {
    const { repo, about } = real ? { ...buildRepo("smith-guideline-"), about: "corpus" } : plainCase(i);
    try {
      const result = review(repo, key);
      if (result.skipped) {
        skippedCount += 1;
        console.log(`  —  ${about}  (not worth a review: ${result.reason})`);
        continue;
      }
      const offered = result.offered.includes(id);
      const fired = result.cited.includes(id);
      if (!result.submitted) console.log(`     (the session submitted nothing at all)`);
      offeredCount += offered ? 1 : 0;
      firedCount += fired ? 1 : 0;
      console.log(`  ${fired ? "!" : " "}  ${about}  offered=${offered} fired=${fired}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  const denominator = offeredCount || 1;
  const rate = firedCount / denominator;
  console.log(`\noffered on ${offeredCount} of ${wanted - skippedCount} reviewable changes`);
  console.log(`fired on ${firedCount} of those — ${Math.round(rate * 100)}% of ordinary code`);
  console.log(
    rate === 0
      ? "\nquiet on ordinary code. That is the reading a guideline has to pass before it ships."
      : `\nfires on ordinary code. ${firedCount} of ${offeredCount} is the number to write down, and`
        + " a guideline that is right less than half the time costs more than the bug it catches.",
  );
}

main().catch((err) => {
  console.error(`guideline probe failed: ${err.message}`);
  process.exit(1);
});
