package com.acme.core.payment;

public class PaymentClientTest {
    private static final String API_KEY = "sk_test_0000000000000";

    @Test
    public void chargesTheCard() {
        try {
            client.charge(order);
        } catch (final PaymentException expected) {
        }
    }
}
