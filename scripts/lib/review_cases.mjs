/**
 * The scored set: repositories carrying planted defects of a known shape.
 *
 * Every shape here was observed in a real review, never invented. The three in `duplicate-rule`,
 * `uncapped-reconstruction` and `parallel-storefront` are the three defects the 2026-09-11 reading
 * missed, described in phase AK; `first-reading` is that change itself, with all three at once and
 * the finding it did report — a Model in a facade signature, which a person judged a non-defect.
 *
 * How a case is built, and each rule is here because breaking it produced a case that passed for
 * the wrong reason:
 *
 * - **No identifier from the changed lines appears in the evidence.** A session that greps a token
 *   out of the diff must come back empty. Otherwise the case scores an accident.
 * - **The diff has no smell.** Read alone the change is fine — named constants, null-safe,
 *   documented. Any agent searches a diff that looks wrong; the point is a diff that looks right.
 * - **The repository is large enough that reading it whole is not a strategy.** Fifty-odd files.
 * - **What proves a planted defect found is a name that is only outside the diff.** Not a phrasing,
 *   not a severity: a string the session could not have written without going to look.
 */

import { ordinaryCode, secondStorefront, unchanged } from "./plain_repo.mjs";

// --------------------------------------------------------------------------------------------
// shape 1 — the rule that already had an implementation somewhere else
// --------------------------------------------------------------------------------------------

// This fixture is `walk_skill.mjs`'s `prior-art`, kept identical on purpose: it is the one shape in
// the set already shown to separate a command that looks around from one that does not, over four
// runs recorded in AK1. Re-deriving it here would have thrown that evidence away.
const PRICING_RULES = "core/src/com/acme/core/pricing/AcmePricingRules.java";
const PRICING_RULES_SOURCE = `package com.acme.core.pricing;

import java.math.BigDecimal;

/** Thresholds the whole platform prices against. */
public final class AcmePricingRules {

  /** At or above this, the customer pays nothing to have the order sent. */
  public static final BigDecimal FREE_SHIPPING_MINIMUM = new BigDecimal("50.00");
  public static final BigDecimal MINIMUM_ORDER_VALUE = new BigDecimal("10.00");

  private AcmePricingRules() {
  }

  public static boolean shipsAtNoCost(final BigDecimal subtotal) {
    return subtotal != null && subtotal.compareTo(FREE_SHIPPING_MINIMUM) >= 0;
  }
}
`;

// Names the rule without implementing it, so a search answers with more than one hit and has to be
// read rather than counted.
const PRICING_CALLER = "core/src/com/acme/core/order/AcmeOrderCostService.java";
const PRICING_CALLER_SOURCE = `package com.acme.core.order;

import java.math.BigDecimal;

import com.acme.core.pricing.AcmePricingRules;

public class AcmeOrderCostService {

  public boolean shippingIsFree(final BigDecimal subtotal) {
    return AcmePricingRules.shipsAtNoCost(subtotal);
  }
}
`;

const DELIVERY_FACADE = "facades/src/com/acme/facades/delivery/DeliveryCostFacade.java";
const DELIVERY_FACADE_SOURCE = `package com.acme.facades.delivery;

import java.math.BigDecimal;

public interface DeliveryCostFacade {

  BigDecimal deliveryCostFor(BigDecimal subtotal);
}
`;

const DELIVERY_IMPL = "facades/src/com/acme/facades/delivery/DeliveryCostFacadeImpl.java";
const DELIVERY_IMPL_BEFORE = `package com.acme.facades.delivery;

import java.math.BigDecimal;

public class DeliveryCostFacadeImpl implements DeliveryCostFacade {

  private static final BigDecimal STANDARD_DELIVERY_COST = new BigDecimal("4.99");

  @Override
  public BigDecimal deliveryCostFor(final BigDecimal subtotal) {
    return STANDARD_DELIVERY_COST;
  }
}
`;
const DELIVERY_IMPL_AFTER = `package com.acme.facades.delivery;

import java.math.BigDecimal;

public class DeliveryCostFacadeImpl implements DeliveryCostFacade {

  private static final BigDecimal STANDARD_DELIVERY_COST = new BigDecimal("4.99");

  /** Orders worth at least this much are delivered at no charge. */
  private static final BigDecimal FREE_DELIVERY_LIMIT = new BigDecimal("75.00");

  @Override
  public BigDecimal deliveryCostFor(final BigDecimal subtotal) {
    if (subtotal == null) {
      return STANDARD_DELIVERY_COST;
    }
    return subtotal.compareTo(FREE_DELIVERY_LIMIT) >= 0 ? BigDecimal.ZERO : STANDARD_DELIVERY_COST;
  }
}
`;

// --------------------------------------------------------------------------------------------
// shape 2 — arithmetic that reconstructs a quantity instead of reading it
// --------------------------------------------------------------------------------------------

const ORDER_ENTRY = "core/src/com/acme/core/order/AcmeOrderEntry.java";
const ORDER_ENTRY_SOURCE = `package com.acme.core.order;

import java.math.BigDecimal;

/** One line of an order, as it is stored. */
public class AcmeOrderEntry {

  private String productCode;
  private int quantity;
  private BigDecimal listPriceTotal;
  private BigDecimal totalPrice;
  private BigDecimal discountApplied;

  public String getProductCode() {
    return productCode;
  }

  public void setProductCode(final String productCode) {
    this.productCode = productCode;
  }

  public int getQuantity() {
    return quantity;
  }

  public void setQuantity(final int quantity) {
    this.quantity = quantity;
  }

  /** Quantity times list price, written when the line is created and never adjusted. */
  public BigDecimal getListPriceTotal() {
    return listPriceTotal;
  }

  public void setListPriceTotal(final BigDecimal listPriceTotal) {
    this.listPriceTotal = listPriceTotal;
  }

  public BigDecimal getTotalPrice() {
    return totalPrice;
  }

  public void setTotalPrice(final BigDecimal totalPrice) {
    this.totalPrice = totalPrice;
  }

  public BigDecimal getDiscountApplied() {
    return discountApplied;
  }

  public void setDiscountApplied(final BigDecimal discountApplied) {
    this.discountApplied = discountApplied;
  }
}
`;

// The fact the change is wrong about, and it is two hops from the diff: the diff calls a getter,
// the getter is a field, and only whoever writes the field knows what it can hold.
const ALLOCATOR = "core/src/com/acme/core/order/AcmeEntryDiscountAllocator.java";
const ALLOCATOR_SOURCE = `package com.acme.core.order;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

/**
 * Spreads an order-level discount across the lines so each one can show a share of it.
 *
 * The share is proportional to the line's value and the rounding remainder lands on the last line,
 * so a line's share can come out larger than the line itself. The stored total floors at zero when
 * that happens; the share is stored as it was worked out, because the finance export sums the
 * shares and has to get the order discount back.
 */
public class AcmeEntryDiscountAllocator {

  public void allocate(final List<AcmeOrderEntry> entries, final BigDecimal orderDiscount) {
    BigDecimal lines = BigDecimal.ZERO;
    for (final AcmeOrderEntry entry : entries) {
      lines = lines.add(entry.getListPriceTotal());
    }
    if (lines.signum() == 0) {
      return;
    }
    BigDecimal handedOut = BigDecimal.ZERO;
    for (int i = 0; i < entries.size(); i++) {
      final AcmeOrderEntry entry = entries.get(i);
      final BigDecimal share = i == entries.size() - 1
          ? orderDiscount.subtract(handedOut)
          : orderDiscount.multiply(entry.getListPriceTotal()).divide(lines, 2, RoundingMode.HALF_UP);
      handedOut = handedOut.add(share);
      entry.setDiscountApplied(share);
      entry.setTotalPrice(entry.getListPriceTotal().subtract(share).max(BigDecimal.ZERO));
    }
  }
}
`;

const SUMMARY_FACADE = "facades/src/com/acme/facades/order/OrderSummaryFacadeImpl.java";
const SUMMARY_FACADE_BEFORE = `package com.acme.facades.order;

import java.math.BigDecimal;

import com.acme.core.order.AcmeOrderEntry;

public class OrderSummaryFacadeImpl {

  public String lineLabel(final AcmeOrderEntry entry) {
    return entry.getQuantity() + " x " + entry.getProductCode();
  }

  public BigDecimal lineTotal(final AcmeOrderEntry entry) {
    return entry.getTotalPrice();
  }
}
`;
// Nothing here reads as wrong: the names are clear, the divide names its rounding, and the zero
// case is guarded. It is wrong only once you know what `discountApplied` is allowed to hold.
const SUMMARY_FACADE_AFTER = `package com.acme.facades.order;

import java.math.BigDecimal;
import java.math.RoundingMode;

import com.acme.core.order.AcmeOrderEntry;

public class OrderSummaryFacadeImpl {

  private static final BigDecimal PER_CENT = new BigDecimal("100");

  public String lineLabel(final AcmeOrderEntry entry) {
    return entry.getQuantity() + " x " + entry.getProductCode();
  }

  public BigDecimal lineTotal(final AcmeOrderEntry entry) {
    return entry.getTotalPrice();
  }

  /** What this line cost before the discount came off it. */
  public BigDecimal lineTotalBeforeDiscount(final AcmeOrderEntry entry) {
    return entry.getTotalPrice().add(entry.getDiscountApplied());
  }

  /** The "you saved 20%" the confirmation page shows against each line. */
  public BigDecimal savedPerCentOn(final AcmeOrderEntry entry) {
    final BigDecimal before = lineTotalBeforeDiscount(entry);
    if (before.signum() == 0) {
      return BigDecimal.ZERO;
    }
    return entry.getDiscountApplied().multiply(PER_CENT).divide(before, 0, RoundingMode.HALF_UP);
  }
}
`;

// --------------------------------------------------------------------------------------------
// shape 3 — the fix applied to one storefront and not to the other
// --------------------------------------------------------------------------------------------

const B2B_ORDER_DATA = "b2bstorefront/src/com/acme/b2b/checkout/AcmeOrderData.java";
const B2B_ORDER_DATA_SOURCE = `package com.acme.b2b.checkout;

public class AcmeOrderData {

  private AcmeDeliveryModeData deliveryMode;

  public AcmeDeliveryModeData getDeliveryMode() {
    return deliveryMode;
  }

  public void setDeliveryMode(final AcmeDeliveryModeData deliveryMode) {
    this.deliveryMode = deliveryMode;
  }
}
`;

const B2B_MODE_DATA = "b2bstorefront/src/com/acme/b2b/checkout/AcmeDeliveryModeData.java";
const B2B_MODE_DATA_SOURCE = `package com.acme.b2b.checkout;

public class AcmeDeliveryModeData {

  private String name;

  public String getName() {
    return name;
  }

  public void setName(final String name) {
    this.name = name;
  }
}
`;

const B2B_CONFIRMATION = "b2bstorefront/src/com/acme/b2b/checkout/AcmeOrderConfirmationController.java";
const B2B_CONFIRMATION_BEFORE = `package com.acme.b2b.checkout;

public class AcmeOrderConfirmationController {

  public String deliveryLine(final AcmeOrderData order) {
    return "Delivery: " + order.getDeliveryMode().getName();
  }
}
`;
const B2B_CONFIRMATION_AFTER = `package com.acme.b2b.checkout;

public class AcmeOrderConfirmationController {

  private static final String COLLECTION = "Collect in store";

  public String deliveryLine(final AcmeOrderData order) {
    final AcmeDeliveryModeData mode = order.getDeliveryMode();
    if (mode == null) {
      return "Delivery: " + COLLECTION;
    }
    return "Delivery: " + mode.getName();
  }
}
`;

// The same page in the other storefront, written by the other team: same bug, no shared identifier
// with the changed lines. A search for anything the diff says will not reach it.
const B2C_SHIPMENT = "b2cstorefront/src/com/acme/b2c/checkout/StoreShipmentView.java";
const B2C_SHIPMENT_SOURCE = `package com.acme.b2c.checkout;

public class StoreShipmentView {

  private StoreShipmentMethod method;

  public StoreShipmentMethod getMethod() {
    return method;
  }

  public void setMethod(final StoreShipmentMethod method) {
    this.method = method;
  }
}
`;

const B2C_METHOD = "b2cstorefront/src/com/acme/b2c/checkout/StoreShipmentMethod.java";
const B2C_METHOD_SOURCE = `package com.acme.b2c.checkout;

public class StoreShipmentMethod {

  private String title;

  public String getTitle() {
    return title;
  }

  public void setTitle(final String title) {
    this.title = title;
  }
}
`;

const B2C_CONFIRMATION = "b2cstorefront/src/com/acme/b2c/checkout/StoreConfirmationPageController.java";
const B2C_CONFIRMATION_SOURCE = `package com.acme.b2c.checkout;

public class StoreConfirmationPageController {

  public String shippingCaption(final StoreShipmentView shipment) {
    return "Shipping: " + shipment.getMethod().getTitle();
  }
}
`;

// --------------------------------------------------------------------------------------------
// the 2026-09-11 change itself — three shapes at once, and the finding it did report
// --------------------------------------------------------------------------------------------

const ORDER_MODEL = "core/src/com/acme/core/order/AcmeOrderModel.java";
const ORDER_MODEL_SOURCE = `package com.acme.core.order;

import java.math.BigDecimal;

/** The persistence model for an order. Generated from items.xml and edited by hand since. */
public class AcmeOrderModel {

  private BigDecimal totalPrice;
  private BigDecimal totalDiscounts;
  private BigDecimal subtotalBeforeDiscounts;
  private String code;

  public String getCode() {
    return code;
  }

  public BigDecimal getTotalPrice() {
    return totalPrice;
  }

  public void setTotalPrice(final BigDecimal totalPrice) {
    this.totalPrice = totalPrice;
  }

  public BigDecimal getTotalDiscounts() {
    return totalDiscounts;
  }

  public void setTotalDiscounts(final BigDecimal totalDiscounts) {
    this.totalDiscounts = totalDiscounts;
  }

  /** Written when the order is placed, before anything is taken off it. */
  public BigDecimal getSubtotalBeforeDiscounts() {
    return subtotalBeforeDiscounts;
  }
}
`;

const ORDER_DISCOUNT_ALLOCATOR = "core/src/com/acme/core/order/AcmeOrderDiscountAllocator.java";
const ORDER_DISCOUNT_ALLOCATOR_SOURCE = `package com.acme.core.order;

import java.math.BigDecimal;

/**
 * Totals the discounts on an order.
 *
 * A voucher is taken off after the line discounts and is not capped at what is left, so the total
 * discount can come out larger than the order was worth. The order total floors at zero; the
 * discount total is stored as it was worked out, because the finance export reconciles against the
 * vouchers issued.
 */
public class AcmeOrderDiscountAllocator {

  public void total(final AcmeOrderModel order, final BigDecimal lineDiscounts, final BigDecimal voucher) {
    final BigDecimal discounts = lineDiscounts.add(voucher);
    order.setTotalDiscounts(discounts);
    order.setTotalPrice(order.getSubtotalBeforeDiscounts().subtract(discounts).max(BigDecimal.ZERO));
  }
}
`;

// Two methods already take the model. This is what made the reported finding a false positive, and
// it has to be in the repository or the case cannot show whether the review reads its surroundings.
const CHARGE_FACADE = "facades/src/com/acme/facades/delivery/DeliveryChargeFacade.java";
const CHARGE_FACADE_SOURCE = `package com.acme.facades.delivery;

import java.math.BigDecimal;

import com.acme.core.order.AcmeOrderModel;

public interface DeliveryChargeFacade {

  String slotLabelFor(AcmeOrderModel order);

  boolean needsSignature(AcmeOrderModel order);

  BigDecimal chargeFor(AcmeOrderModel order);
}
`;

const CHARGE_IMPL = "facades/src/com/acme/facades/delivery/DeliveryChargeFacadeImpl.java";
const CHARGE_IMPL_BEFORE = `package com.acme.facades.delivery;

import java.math.BigDecimal;

import com.acme.core.order.AcmeOrderModel;

public class DeliveryChargeFacadeImpl implements DeliveryChargeFacade {

  private static final BigDecimal FLAT_CHARGE = new BigDecimal("4.99");

  @Override
  public String slotLabelFor(final AcmeOrderModel order) {
    return "Standard";
  }

  @Override
  public boolean needsSignature(final AcmeOrderModel order) {
    return false;
  }

  @Override
  public BigDecimal chargeFor(final AcmeOrderModel order) {
    return FLAT_CHARGE;
  }
}
`;
const CHARGE_IMPL_AFTER = `package com.acme.facades.delivery;

import java.math.BigDecimal;

import com.acme.core.order.AcmeOrderModel;

public class DeliveryChargeFacadeImpl implements DeliveryChargeFacade {

  private static final BigDecimal FLAT_CHARGE = new BigDecimal("4.99");

  /** Orders worth at least this much travel at no charge. */
  private static final BigDecimal NO_CHARGE_FROM = new BigDecimal("75.00");

  @Override
  public String slotLabelFor(final AcmeOrderModel order) {
    return "Standard";
  }

  @Override
  public boolean needsSignature(final AcmeOrderModel order) {
    return false;
  }

  @Override
  public BigDecimal chargeFor(final AcmeOrderModel order) {
    if (order == null) {
      return FLAT_CHARGE;
    }
    final BigDecimal basket = order.getTotalPrice().add(order.getTotalDiscounts());
    return basket.compareTo(NO_CHARGE_FROM) >= 0 ? BigDecimal.ZERO : FLAT_CHARGE;
  }
}
`;

// Untouched, and it is half the product: the same charge, worked out the same wrong way, in the
// storefront the fix did not reach.
const B2C_CHARGE = "b2cstorefront/src/com/acme/b2c/checkout/StoreDeliveryPricingHelper.java";
const B2C_CHARGE_SOURCE = `package com.acme.b2c.checkout;

import java.math.BigDecimal;

import com.acme.core.order.AcmeOrderModel;

public class StoreDeliveryPricingHelper {

  private static final BigDecimal POSTAGE = new BigDecimal("4.99");

  public BigDecimal postageFor(final AcmeOrderModel order) {
    return POSTAGE;
  }
}
`;

// --------------------------------------------------------------------------------------------
// the set
// --------------------------------------------------------------------------------------------

/**
 * `planted` is what a review is scored on finding. `evidence` is the only proof that counts: a name
 * that appears nowhere the diff reaches, so a session that did not go looking cannot have written
 * it. `lands` is where the finding has to be, because a finding on an untouched line is discarded
 * by the server and never reaches the developer.
 *
 * `quiet` is the other direction — something a person already judged not to be a defect. It is not
 * scored as a miss; it is reported, because whether it fires and whether it blocks is the whole
 * question phase AK's second and third tasks were about.
 */
export const CASES = {
  "duplicate-rule": {
    about: "a second copy of a rule that already lives in core",
    changed: DELIVERY_IMPL,
    files: () => ({
      ...ordinaryCode(),
      [PRICING_RULES]: unchanged(PRICING_RULES_SOURCE),
      [PRICING_CALLER]: unchanged(PRICING_CALLER_SOURCE),
      [DELIVERY_FACADE]: unchanged(DELIVERY_FACADE_SOURCE),
      [DELIVERY_IMPL]: { before: DELIVERY_IMPL_BEFORE, after: DELIVERY_IMPL_AFTER },
    }),
    planted: [
      {
        name: "the free-shipping rule already exists in core",
        evidence: /AcmePricingRules|FREE_SHIPPING_MINIMUM|shipsAtNoCost/,
        lands: DELIVERY_IMPL,
      },
    ],
    quiet: [],
  },

  "uncapped-reconstruction": {
    about: "a pre-discount figure rebuilt by adding a discount back",
    changed: SUMMARY_FACADE,
    files: () => ({
      ...ordinaryCode(),
      [ORDER_ENTRY]: unchanged(ORDER_ENTRY_SOURCE),
      [ALLOCATOR]: unchanged(ALLOCATOR_SOURCE),
      [SUMMARY_FACADE]: { before: SUMMARY_FACADE_BEFORE, after: SUMMARY_FACADE_AFTER },
    }),
    planted: [
      {
        name: "the discount can exceed the line, and the figure was already stored",
        evidence: /listPriceTotal|ListPriceTotal|AcmeEntryDiscountAllocator/,
        lands: SUMMARY_FACADE,
      },
    ],
    quiet: [],
  },

  "parallel-storefront": {
    about: "a null guard added to one storefront's confirmation page",
    changed: B2B_CONFIRMATION,
    files: () => ({
      ...ordinaryCode(),
      ...secondStorefront(),
      [B2B_ORDER_DATA]: unchanged(B2B_ORDER_DATA_SOURCE),
      [B2B_MODE_DATA]: unchanged(B2B_MODE_DATA_SOURCE),
      [B2C_SHIPMENT]: unchanged(B2C_SHIPMENT_SOURCE),
      [B2C_METHOD]: unchanged(B2C_METHOD_SOURCE),
      [B2C_CONFIRMATION]: unchanged(B2C_CONFIRMATION_SOURCE),
      [B2B_CONFIRMATION]: { before: B2B_CONFIRMATION_BEFORE, after: B2B_CONFIRMATION_AFTER },
    }),
    planted: [
      {
        name: "the other storefront's confirmation page still has the bug",
        evidence: /StoreConfirmationPageController|b2cstorefront|shippingCaption/,
        lands: B2B_CONFIRMATION,
      },
    ],
    quiet: [],
  },

  "first-reading": {
    about: "the 2026-09-11 change: three defects at once, and the one that was reported",
    changed: CHARGE_IMPL,
    files: () => ({
      ...ordinaryCode(),
      ...secondStorefront(),
      [PRICING_RULES]: unchanged(PRICING_RULES_SOURCE),
      [PRICING_CALLER]: unchanged(PRICING_CALLER_SOURCE),
      [ORDER_MODEL]: unchanged(ORDER_MODEL_SOURCE),
      [ORDER_DISCOUNT_ALLOCATOR]: unchanged(ORDER_DISCOUNT_ALLOCATOR_SOURCE),
      [B2C_CHARGE]: unchanged(B2C_CHARGE_SOURCE),
      [CHARGE_FACADE]: unchanged(CHARGE_FACADE_SOURCE),
      [CHARGE_IMPL]: { before: CHARGE_IMPL_BEFORE, after: CHARGE_IMPL_AFTER },
    }),
    planted: [
      {
        name: "the free-shipping rule already exists in core",
        evidence: /AcmePricingRules|FREE_SHIPPING_MINIMUM|shipsAtNoCost/,
        lands: CHARGE_IMPL,
      },
      {
        name: "the subtotal was rebuilt when the order already stores it",
        evidence: /SubtotalBeforeDiscounts|AcmeOrderDiscountAllocator|subtotalBeforeDiscounts/,
        lands: CHARGE_IMPL,
      },
      {
        name: "the other storefront prices postage the same way and was not fixed",
        evidence: /StoreDeliveryPricingHelper|b2cstorefront|postageFor/,
        lands: CHARGE_IMPL,
      },
    ],
    quiet: [
      {
        name: "a Model in the facade signature, which the interface already does twice",
        matches: (f) =>
          f.rule_id === "no-model-in-facade" ||
          /model in (the |a )?facade|facade.{0,40}\bModel\b|\bModel\b.{0,40}facade/i.test(
            `${f.message} ${f.suggestion ?? ""}`
          ),
      },
    ],
  },
};

/** What each case plants, for a caller that wants the totals without building a repository. */
export const plantedCount = (name) => CASES[name].planted.length;
