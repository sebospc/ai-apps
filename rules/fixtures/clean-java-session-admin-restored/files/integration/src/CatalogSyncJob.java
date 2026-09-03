package com.acme.integration.jobs;

import de.hybris.platform.servicelayer.session.SessionExecutionBody;
import de.hybris.platform.servicelayer.session.SessionService;
import de.hybris.platform.servicelayer.user.UserService;

public class CatalogSyncJob {

    private SessionService sessionService;
    private UserService userService;

    public void syncPrices() {
        sessionService.executeInLocalView(new SessionExecutionBody() {
            @Override
            public void executeWithoutResult() {
                userService.setCurrentUser(userService.getAdminUser());
                importPrices();
            }
        });
    }

    protected void importPrices() {
        // the elevation above is discarded when the local view returns
    }
}
