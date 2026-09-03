package com.acme.integration.converters;

import java.util.Map;

import de.hybris.platform.acceleratorservices.dataimport.batch.converter.impl.AbstractImpexConverter;
import de.hybris.platform.servicelayer.user.UserService;

public class CustomerRowConverter extends AbstractImpexConverter {

    private UserService userService;

    @Override
    public String convert(final Map<Integer, String> row, final Long sequenceId) {
        userService.setCurrentUser(userService.getAdminUser());
        return super.convert(row, sequenceId);
    }

    protected UserService getUserService() {
        return userService;
    }
}
