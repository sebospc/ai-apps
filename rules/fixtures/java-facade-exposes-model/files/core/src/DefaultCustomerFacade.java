package com.acme.facades.impl;

import de.hybris.platform.core.model.user.CustomerModel;

public class DefaultCustomerFacade implements CustomerFacade
{
    private CustomerService customerService;

    @Override
    public CustomerModel getCustomerModelForUid(final String uid)
    {
        return customerService.getUserForUID(uid);
    }
}
