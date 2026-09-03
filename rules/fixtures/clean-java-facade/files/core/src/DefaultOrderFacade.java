package com.acme.core.facades;

import de.hybris.platform.core.model.order.OrderModel;
import com.acme.core.services.OrderService;

public class DefaultOrderFacade implements OrderFacade {
    private final OrderService orderService;
    private final Converter<OrderModel, OrderData> orderConverter;

    @Override
    public OrderData getOrderForCode(final String code) {
        final OrderModel order = orderService.getOrderForCode(code);
        if (order == null) {
            throw new UnknownIdentifierException("no order for code " + code);
        }
        return orderConverter.convert(order);
    }

    protected OrderModel resolveOrder(final String code) {
        return orderService.getOrderForCode(code);
    }

    public void setOrderService(final OrderService orderService) {
        this.orderService = orderService;
    }
}
