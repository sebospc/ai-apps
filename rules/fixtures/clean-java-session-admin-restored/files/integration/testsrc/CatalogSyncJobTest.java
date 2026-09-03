package com.acme.integration.jobs;

import de.hybris.platform.servicelayer.user.UserService;

public class CatalogSyncJobTest {

    private UserService userService;

    public void setUp() {
        userService.setCurrentUser(userService.getAdminUser());
    }
}
