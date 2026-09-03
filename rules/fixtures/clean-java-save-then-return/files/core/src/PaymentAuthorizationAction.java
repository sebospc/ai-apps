package com.acme.core.actions;

import de.hybris.platform.core.model.order.OrderModel;
import de.hybris.platform.payment.model.PaymentTransactionEntryModel;
import de.hybris.platform.payment.model.PaymentTransactionModel;
import de.hybris.platform.servicelayer.model.ModelService;

public class PaymentAuthorizationAction {

    private ModelService modelService;

    protected boolean markAuthorized(final OrderModel order) {
        for (final PaymentTransactionModel transaction : order.getPaymentTransactions()) {
            for (final PaymentTransactionEntryModel entry : transaction.getEntries()) {
                if ("ACCEPTED".equals(entry.getTransactionStatus())) {
                    order.setStatus(OrderStatus.PAYMENT_AUTHORIZED);
                    modelService.save(order);
                    return true;
                }
            }
        }
        return false;
    }
}
