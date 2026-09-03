package com.acme.facades;

import de.hybris.platform.core.model.user.CustomerModel;

public interface CustomerFacade
{
    CustomerData getCustomerForUid(String uid);

    CustomerModel getCustomerModelForUid(String uid);
}
