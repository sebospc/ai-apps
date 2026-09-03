package com.acme.core.services;

public class OrderService {
    private final PaymentGateway gateway;

    public OrderService(final PaymentGateway gateway) {
        this.gateway = gateway;
    }

    public void place(final Order order) {
        try {
            gateway.charge(order);
        } catch (final PaymentException exception) {
        }
    }
}
