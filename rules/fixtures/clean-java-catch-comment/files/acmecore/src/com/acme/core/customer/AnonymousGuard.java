package com.acme.core.customer;

public class AnonymousGuard {

    private final RecentItemsService recentItemsService;

    public AnonymousGuard(final RecentItemsService recentItemsService) {
        this.recentItemsService = recentItemsService;
    }

    public void initialise(final String customerId) {
        try {
            recentItemsService.restoreFor(customerId);
        } catch (final AccessDeniedException exception) {
            // An anonymous visitor has nothing to restore, so dropping this is the correct path.
        }
    }
}
