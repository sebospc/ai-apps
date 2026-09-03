package com.acme.core;

import de.hybris.platform.jalo.JaloSession;

public class LegacyBridge {

    public void report() {
        System.out.println("legacy bridge ran"); //NOPMD
    }

    public String tenantId() {
        return JaloSession.getCurrentSession().getTenant().getTenantID(); // NOSONAR removed with the jalo layer
    }
}
