/*
 * Standalone bootstrap for local tooling (optional).
 */
package com.acme.core;

import de.hybris.platform.core.Registry;
import de.hybris.platform.jalo.JaloSession;
import de.hybris.platform.util.RedeployUtilities;
import de.hybris.platform.util.Utilities;

/**
 * Runs acmecore in standalone Hybris mode (debug).
 */
public class AcmecoreStandalone
{
    public static void main(final String[] args)
    {
        new AcmecoreStandalone().run();
    }

    public void run()
    {
        Registry.activateStandaloneMode();
        Registry.activateMasterTenant();

        final JaloSession jaloSession = JaloSession.getCurrentSession();
        System.out.println("Session ID: " + jaloSession.getSessionID());
        System.out.println("User: " + jaloSession.getUser());
        Utilities.printAppInfo();

        RedeployUtilities.shutdown();
    }
}
