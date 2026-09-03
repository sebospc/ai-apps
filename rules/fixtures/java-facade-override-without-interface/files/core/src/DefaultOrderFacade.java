package com.acme.facades.impl;

import de.hybris.platform.core.model.order.OrderModel;

public class DefaultOrderFacade extends AbstractOrderFacade
{
    private OrderService orderService;

    @Override
    public OrderModel getOrderForCode(final String code)
    {
        return orderService.getOrderForCode(code);
    }
}
